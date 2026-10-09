/**
 * Shared test helpers and the IPC peer entry point.
 *
 * Ports are a FIXED table keyed by name. Not a counter: `node:test` runs each file in its own process, so a
 * counter restarts at zero per file and two suites collide. A name maps to the same port every run, so a
 * stranded port points at exactly one test.
 */

import NApp from '../index.ts'
import { NACEB, PipelineHandler, TaskHandler } from '../NACEB/index.ts'
import { NACAB } from '../NACAB/index.ts'
import TCPServerProvider from '../packages/nact-tcp-server/index.ts'
import TCPClientProvider from '../packages/nact-tcp-client/index.ts'
import UnixServerProvider from '../packages/nact-unix-server/index.ts'
import UnixClientProvider from '../packages/nact-unix-client/index.ts'
import WebSocketServerProvider from '../packages/nact-websocket-server/index.ts'
import WebSocketClientProvider from '../packages/nact-websocket-client/index.ts'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as flush } from 'node:timers/promises'
import { packFrameHeader } from '../NACT/framing.ts'
import HTTPClient from '../packages/nact-streamable-http-client/index.ts'
import { NACT_PREFACE } from '../packages/nact-provider-shared/index.ts'

// ── addresses ──────────────────────────────────────────────────────────────────────────────────────────
// 18900-18999 reserved for NASDK tests; simple/ owns 189 0x, full/ 189 1x-189 4x, edge/ 189 5x-189 7x.
export const PORT = {
  napp: 18910, nappB: 18911, nappC: 18912, nappGw: 18913, nappGw2: 18914,
  hb: 18915, hbB: 18916, hbC: 18917, hbD: 18918, hbE: 18919, hbF: 18923,
  nacp: 18920, nact: 18921, nactWs: 18922,
  sig: 18940, sigB: 18941, sigC: 18942, sigD: 18943, sigE: 18944, sigF: 18945,
  sigG: 18946, sigH: 18947, sigI: 18948, sigJ: 18949,
  edge: 18950, edgeB: 18951, edgeWs: 18952, edgeChunk: 18953, edgeMany: 18954, edgeDead: 18955,
  edgeGatewayMany: 18956,
}

/** A unix socket path unique to this process AND this name, so concurrent runs never share one. */
export const sock = (name) => join(tmpdir(), `nasdk-t-${name}-${process.pid}.sock`)

/** `chunkSize` goes to the NACT part of the spec; everything else is the Provider's own options. */
const spec = (type, provider, { chunkSize, ...rest }) =>
  ({ type, provider: { ...provider, ...rest }, ...(chunkSize === undefined ? {} : { nact: { chunkSize } }) })

// One spec serves both ends: each Provider reads only its own fields (the ws server takes host/port/path,
// the ws client takes url), so a test can pass the same value to `server: [...]` and `connect()`.
export const tcp = (port, opt = {}) => spec('tcp', { host: '127.0.0.1', port }, opt)
export const ws = (port, opt = {}) =>
  spec('websocket', { host: '127.0.0.1', port, path: '/ws', url: `ws://127.0.0.1:${port}/ws` }, opt)
export const unix = (name, opt = {}) => spec('unix', { path: sock(name) }, opt)

/** Register every official Provider the kit's specs use. Must run before `app.start()`. */
export function useProviders(app) {
  for (const provider of [
    new TCPServerProvider(), new TCPClientProvider(),
    new UnixServerProvider(), new UnixClientProvider(),
    new WebSocketServerProvider(), new WebSocketClientProvider(),
  ]) app.nact.use(provider)
  return app
}

// ── handlers ───────────────────────────────────────────────────────────────────────────────────────────

/** Reports `n` process chunks, then returns. The shape most tests need: it makes the process stream countable
 *  without depending on real work. `n` comes from the event payload. */
class Emit extends TaskHandler {
  name = 'emit'
  description = 'report n chunks then return'
  async execute() {
    const n = this.input?.n ?? 3
    for (let i = 0; i < n; i++) this.processingResultReport({ i })
    return { emitted: n }
  }
}

/** Blocks until the resolver it pushes is called. The queue travels in the event PAYLOAD, not a module global:
 *  `node:test` runs tests concurrently, and a shared queue would let one test release another's task. */
class Hang extends TaskHandler {
  name = 'hang'
  description = 'block until released'
  async execute() {
    return new Promise((resolve) => { (this.pipeline.event.payload.release ??= []).push(resolve) })
  }
}

class Boom extends TaskHandler {
  name = 'boom'
  description = 'always throws'
  async execute() { throw new Error(this.input?.msg ?? 'boom') }
}

/** Occupies `busyKeys` while it runs and records concurrency into the payload's `stats`, so a test can assert
 *  that same-key tasks never overlap. */
class Busy extends TaskHandler {
  name = 'busy'
  description = 'hold a busyKey for a while'
  busyKeys = ['gpu']
  async execute() {
    const s = this.input.stats
    s.now++; s.peak = Math.max(s.peak, s.now)
    await new Promise((r) => setTimeout(r, this.input?.ms ?? 20))
    s.now--
    return s.peak
  }
}

/** One step: run `payload.task` (default 'emit') once, then terminate with its result. */
class OneStep extends PipelineHandler {
  name = 'oneStep'
  description = 'run one task then terminate'
  next(last) {
    if (last === undefined) return { task: this.event.payload?.task ?? 'emit', input: this.event.payload }
    return { task: '$terminal', input: last }
  }
}

/** N steps of 'emit', so a test can watch several tasks inside one event. */
class MultiStep extends PipelineHandler {
  name = 'multiStep'
  description = 'run emit `steps` times'
  next(last) {
    if (last === undefined) { this.state.left = this.event.payload?.steps ?? 2 }
    if (this.state.left-- > 0) return { task: 'emit', input: this.event.payload }
    return { task: '$terminal', input: { done: true } }
  }
}

/**
 * A NACEB exposing `run` (one task) and `multi` (emit N times).
 *
 * Nothing is stashed on the module or the prototypes: the `hang` and `busy` handlers take their side channel
 * from the request payload (`{release: []}` / `{stats: {...}}`), so two concurrently-running tests cannot
 * touch each other's. A test that wants to release a hung task passes its own array in and calls the
 * resolvers itself.
 */
export function makeNaceb() {
  return new NACEB({
    pipelineHandlers: [new OneStep(), new MultiStep()],
    taskHandlers: [new Emit(), new Hang(), new Boom(), new Busy()],
    eventAlias: [
      { eventName: 'run', pipelineName: 'oneStep', description: 'run one task' },
      { eventName: 'multi', pipelineName: 'multiStep', description: 'run emit repeatedly' },
    ],
  })
}

/** A NACAB with the abilities full/ and edge/ need. */
export function makeNacab() {
  const nacab = new NACAB()
  nacab.register({ name: 'add', description: 'a+b', execute: (p) => p.a + p.b })
  nacab.register({ name: 'echo', description: 'echo', execute: (p) => p })
  nacab.register({ name: 'slow', description: 'sleep then echo', execute: async (p) => {
    await new Promise((r) => setTimeout(r, p?.ms ?? 10)); return p
  } })
  nacab.register({ name: 'fail', description: 'throws', execute: () => { throw new Error('ability failed') } })
  return nacab
}

// ── apps ───────────────────────────────────────────────────────────────────────────────────────────────

/** Assemble + start an App with both kit processors bound. Returns the App and the two processors, because a
 *  test asserting on processor-internal observation needs the instances, not just the adaptors. */
export async function startApp(id, { server = [], opt, bind = true } = {}) {
  const app = useProviders(new NApp({ id, server, opt }))
  let naceb, nacab
  if (bind) {
    naceb = makeNaceb(); nacab = makeNacab()
    app.bindProcessor('event', naceb.nacpAdaptor)
    app.bindProcessor('ability', nacab.nacpAdaptor)
  }
  await app.start()
  return { app, naceb, nacab, stop: () => app.terminate() }
}

/** A server App plus a client App already registered with it — the pair most full/ tests need. */
export async function startPair(spec, { serverId = 'srv', clientId = 'cli', serverOpt, clientOpt } = {}) {
  const s = await startApp(serverId, { server: [spec], opt: serverOpt })
  const c = await startApp(clientId, { opt: clientOpt })
  await c.app.connect(serverId, spec)
  return {
    srv: s.app, cli: c.app, naceb: s.naceb, nacab: s.nacab, cliNaceb: c.naceb, cliNacab: c.nacab,
    stop: async () => { await c.stop().catch(() => {}); await s.stop().catch(() => {}) },
  }
}

/** An App with no server entry — the host a layer unit test needs so `app.nacp` / `app.nact` exist. */
export async function startBare(id, opt) {
  const app = useProviders(new NApp({ id, opt }))
  await app.start()
  return app
}

// ── fake peers (layer tests never open a socket) ────────────────────────────────────────────────────────

/**
 * A Peer that records what NACP hands it, acknowledges every reliable message, and answers the four
 * handshake types with an isOk response.
 *
 * The auto-answer is load-bearing, not cosmetic: `NApp.terminate()` sends an unregister to every bound appId
 * and awaits the ack, so a peer that only records makes teardown wait out the full 10s RESPONSE_TIMEOUT_MS.
 * Measured 10007ms per test without it, 0.5ms with.
 *
 * Pass `answer:false` when the silence IS the thing under test (edge/ does this for the timeout path).
 */
export function fakePeer(app, id = 'fake-peer', { answer = true } = {}) {
  const sent = []
  const peer = {
    id,
    async send(msg) {
      sent.push(msg)
      if (!answer) return
      if (msg.type !== 'notify' && msg.type !== 'ack') {
        queueMicrotask(() => app.nacp.inbound({
          v: msg.v, type: 'ack', id: `ack-${msg.id}`, from: msg.to, to: msg.from, t: Date.now(),
          meta: { parentId: msg.id },
        }, peer))
      }
      if (msg.type === 'register' || msg.type === 'unregister'
        || msg.type === 'subscribe' || msg.type === 'unsubscribe') {
        queueMicrotask(() => app.nacp.inbound({
          v: msg.v, type: 'response', id: `response-${msg.id}`, from: msg.to, to: msg.from, t: Date.now(),
          meta: { parentId: msg.id, isOk: true }, payload: {},
        }, peer))
      }
    },
    close() { peer.closed = true },
    closed: false,
  }
  return { peer, sent }
}

/** Hand-build an inbound message — the only way to exercise a receive path a cooperating peer never produces
 *  (a malformed frame, an unknown subscription, a cross-major version). */
export function msg(type, { from = 'other', to = 'me', id, meta = {}, payload = {}, v } = {}) {
  return {
    v: v ?? { major: 2, minor: 1 }, type, id: id ?? `m-${++seq}`,
    from, to, t: Date.now(), meta, payload,
  }
}
let seq = 0

export const registerMsg = (o = {}) => msg('register', {
  ...o, payload: { isGateway: false, decl: { events: [], abilities: [] }, ...(o.payload ?? {}) },
})

// ── misc ───────────────────────────────────────────────────────────────────────────────────────────────

/** Time an async fn. Returns [result, ms]. edge/ prints these; nothing asserts on them. */
export async function timed(fn) {
  const t0 = performance.now()
  const out = await fn()
  return [out, performance.now() - t0]
}

/** Throughput line for edge/ output. */
export function rate(label, bytes, ms) {
  const mb = bytes / 1024 / 1024
  return `${label}: ${mb.toFixed(2)}MB in ${ms.toFixed(1)}ms = ${(mb / (ms / 1000)).toFixed(1)}MB/s`
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Await one bus event, with a timeout so a missing event fails loudly instead of hanging the suite. */
export function waitFor(bus, key, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off(id); reject(new Error(`waitFor('${key}') timed out after ${ms}ms`)) }, ms)
    const id = bus.listen(key, (payload, hitKey) => { clearTimeout(timer); bus.off(id); resolve({ payload, hitKey }) })
  })
}

/** Collect every event matching `key` until stop(). */
export function collect(bus, key) {
  const events = []
  const id = bus.listen(key, (payload, hitKey) => events.push({ payload, hitKey }))
  return { events, stop: () => bus.off(id) }
}

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function inbox(channel) {
  const values = [], waiting = []
  channel.onReceive(frame => {
    const bytes = Buffer.concat(frame)
    if (waiting.length) waiting.shift()(bytes)
    else values.push(bytes)
  })
  return () => values.length ? Promise.resolve(values.shift()) : new Promise(resolve => waiting.push(resolve))
}

export function frameOf(bytes) {
  return [packFrameHeader(crypto.getRandomValues(new Uint8Array(16)), 0, bytes.length, bytes.length), bytes]
}

export async function providerPair(t, location, opt = {}) {
  const name = new URL('..', location).pathname.split('/').filter(Boolean).at(-1)
  const type = name.replace(/^nact-/, '').replace(/-(client|server)$/, '')
  const providers = await Promise.all(['client', 'server'].map(async role => {
    const { default: Provider } = await import(new URL(`../../nact-${type}-${role}/index.ts`, location))
    return new Provider()
  }))
  const port = 18980 + ['tcp', 'unix', 'websocket', 'streamable-http'].indexOf(type) * 2 + (name.endsWith('-server') ? 1 : 0)
  const path = join(tmpdir(), `nact-${process.pid}-${crypto.randomUUID()}.sock`)
  const serverOptions = type === 'unix' ? { path } : { host: '127.0.0.1', port, path: '/frames', idleTimeoutMs: 0 }
  const clientOptions = type === 'unix' ? { path } : type === 'tcp' ? { host: '127.0.0.1', port }
    : { url: `${type === 'websocket' ? 'ws' : 'http'}://127.0.0.1:${port}/frames`, headers: { connection: 'close' } }
  const accepted = deferred()
  const channels = []
  let handle
  t.after(async () => {
    for (const channel of [...channels].reverse()) await channel.close()
    await handle?.close()
  })
  handle = await providers[1].listen({ ...serverOptions, ...opt.server }, channel => {
    channels.push(channel)
    accepted.resolve(channel)
  })
  const client = await providers[0].dial({ ...clientOptions, ...opt.client })
  channels.push(client)
  const server = await accepted.promise
  return { client, server, handle, providers, serverOptions, clientOptions, type }
}

export async function httpChannel(t, options = {}) {
  const posts = []
  const channel = await new HTTPClient().dial({
    url: 'https://provider.test/nacp', ...options,
    fetch: async (_url, init) => {
      if (init.method === 'POST') {
        const gate = deferred()
        posts.push(gate)
        return gate.promise
      }
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(NACT_PREFACE) } }), {
        headers: { 'content-type': 'application/octet-stream', 'x-nact-session': 'session' },
      })
    },
  })
  t.after(async () => {
    for (const post of posts) post.resolve(new Response(null, { status: 204 }))
    await channel.close()
  })
  return { channel, posts }
}

export async function checkProviderDuplex(t, location, size = 5) {
  const { client, server } = await providerPair(t, location)
  const left = inbox(client), right = inbox(server)
  const frame = frameOf(Uint8Array.from({ length: size }, (_, i) => i & 255))
  await client.send(frame)
  assert.deepEqual(await right(), Buffer.concat(frame))
  await server.send(frame)
  assert.deepEqual(await left(), Buffer.concat(frame))
}

export async function checkProviderFrames(t, location) {
  const { client, server } = await providerPair(t, location)
  const receive = inbox(server)
  const frames = [frameOf(new Uint8Array()), frameOf(new Uint8Array(8192).fill(0xcf)), frameOf(new Uint8Array([9]))]
  for (const [header, body] of frames) await client.send([header.subarray(0, 7), header.subarray(7), body.subarray(0, 3), body.subarray(3)])
  for (const frame of frames) assert.deepEqual(await receive(), Buffer.concat(frame))
}

export async function checkProviderClose(t, location) {
  const { client, server } = await providerPair(t, location)
  const closed = deferred()
  let count = 0
  client.onClose(() => { count++; closed.resolve() })
  await server.close()
  await closed.promise
  await client.close()
  await flush()
  assert.equal(count, 1)
  await assert.rejects(async () => client.send(frameOf(new Uint8Array([1]))))
}

export async function checkProviderBurst(t, location) {
  const { client, server } = await providerPair(t, location)
  const receive = inbox(server)
  const frames = Array.from({ length: 1000 }, (_, i) => frameOf(new Uint8Array([i >> 8, i & 255])))
  await Promise.all(frames.map(frame => client.send(frame)))
  for (const frame of frames) assert.deepEqual(await receive(), Buffer.concat(frame))
}

export async function checkProviderReconnect(t, location) {
  const { providers, clientOptions, server } = await providerPair(t, location)
  await server.close()
  for (let i = 0; i < 20; i++) {
    const client = await providers[0].dial(clientOptions)
    await client.close()
  }
}

export const isHeartbeat = message => message.type === 'request' && message.meta.target === 'NApp.heartbeat'
export const acceptanceNotifyOpt = { parentId: 'sub', targetSubName: 'job:*', hitSubName: 'job:step' }

export async function workerWebSocketRuntime(t) {
  const { build } = await import('esbuild')
  const { Miniflare } = await import('miniflare')
  const root = new URL('../', import.meta.url).pathname
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: 'ts',
      contents: `
        import NApp from './index.ts'
        import { NACAB } from './NACAB/index.ts'
        import Provider from './packages/nact-websocket-cloudflare-worker-server/index.ts'
        export default {
          async fetch(request) {
            const url = new URL(request.url)
            if (url.pathname !== '/nacp') return new Response(null, { status: 404 })
            const provider = new Provider()
            const app = new NApp({ id: 'worker', opt: { heartbeatIntervalMs: false },
              server: [{ type: provider.type, provider: {
                authorize: req => !new URL(req.url).searchParams.has('deny'),
              } }] })
            app.nact.use(provider)
            const abilities = new NACAB()
            let count = 0
            abilities.register({ name: 'counter', description: 'connection state', execute: () => ++count })
            abilities.register({ name: 'echo', description: 'binary echo', execute: payload => payload })
            app.bindProcessor('ability', abilities.nacpAdaptor)
            await app.start()
            let connected = false
            app.bus.listen('nact:peer:connect', () => { connected = true })
            app.bus.listen('nact:peer:disconnect', () => { void app.terminate() })
            try {
              const response = await provider.fetch(request)
              if (!connected) await app.terminate()
              return response
            } catch (reason) { await app.terminate(); throw reason }
          }
        }
      `,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    conditions: ['browser'],
  })
  const runtime = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-09-17' })
  t.after(() => runtime.dispose())
  return runtime
}

export async function workerWebSocketClient(t, runtime, query = '') {
  const response = await runtime.dispatchFetch(`https://worker.test/nacp${query}`, { headers: { Upgrade: 'websocket' } })
  assert.equal(response.status, 101)
  const socket = response.webSocket
  socket.accept()
  const client = new NApp({ id: 'client', opt: { heartbeatIntervalMs: false } })
  client.nact.use({
    type: 'worker-test', role: 'client', defaultChunkSize: 64 * 1024,
    dial: async () => ({
      send: parts => {
        const bytes = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0))
        let offset = 0
        for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
        socket.send(bytes)
      },
      close: () => socket.close(1000),
      onReceive: handler => {
        const listener = event => handler([new Uint8Array(event.data)])
        socket.addEventListener('message', listener)
        return () => socket.removeEventListener('message', listener)
      },
      onClose: handler => { socket.addEventListener('close', handler); return () => socket.removeEventListener('close', handler) },
      onError: handler => { socket.addEventListener('error', handler); return () => socket.removeEventListener('error', handler) },
    }),
  })
  await client.start()
  t.after(() => client.terminate())
  await client.connect('worker', { type: 'worker-test', provider: {} })
  return { client, socket }
}

export async function acceptanceApp(t, opt = {}) {
  const app = new NApp({ id: 'me', opt: { heartbeatIntervalMs: false, ...opt } })
  await app.start()
  t.after(async () => { app.nacp.terminate(); await app.nact.terminate() })
  return app
}

export async function controlledChannel(t, send, chunkSize = 96) {
  const app = await acceptanceApp(t)
  const closers = new Set(), errors = new Set()
  let closed = false
  const channel = {
    send,
    close() {
      if (closed) return
      closed = true
      for (const handler of closers) handler()
    },
    onReceive: () => () => {},
    onClose(handler) { closers.add(handler); return () => closers.delete(handler) },
    onError(handler) { errors.add(handler); return () => errors.delete(handler) },
  }
  app.nact.use({ type: 'controlled', role: 'client', defaultChunkSize: chunkSize, dial: async () => channel })
  const peer = await app.nact.dial({ type: 'controlled', provider: {} })
  return { app, peer, channel, errors }
}

export function heartbeatClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  t.mock.method(performance, 'now', () => Date.now())
  return async ms => { t.mock.timers.tick(ms); await flush() }
}

export async function makeHeartbeatApp(t, opt = {}) {
  const app = new NApp({ id: 'me', opt: { heartbeatIntervalMs: 100, ackTimeoutMs: 20, ...opt } })
  await app.start()
  t.after(() => app.terminate())
  return app
}

export async function connectHeartbeatPeer(app, id, { ack = true, respond = true, accepting = false } = {}) {
  const { peer, sent } = fakePeer(app, id)
  const send = peer.send
  const reply = (request, isOk = true) => app.nacp.inbound(msg('response', {
    from: 'them', to: app.id,
    meta: { parentId: request.id, kind: request.meta.kind, isOk }, payload: true,
  }), peer)
  peer.send = async message => {
    if (!isHeartbeat(message)) return send(message)
    if (ack) await send(message)
    else sent.push(message)
    if (respond) queueMicrotask(() => reply(message))
  }
  app.nact.addPeer(peer)
  if (accepting) app.nacp.inbound(registerMsg({ from: 'them', to: app.id }), peer)
  else {
    app.nact.dial = async () => peer
    await app.connect('them', { type: 'test', provider: {} })
  }
  await flush()
  return { peer, sent, reply, heartbeats: () => sent.filter(isHeartbeat) }
}

export function incomingHeartbeat(app, peer) {
  app.nacp.inbound(msg('request', {
    from: 'them', to: app.id, meta: { kind: 'ability', target: 'NApp.heartbeat' }, payload: { from: 'them' },
  }), peer)
}

export async function runTestPeer(mode, cfg) {
  let app
  if (mode === 'simple') {
    class CountDown extends TaskHandler {
      name = 'countDown'
      description = '从 n 数到 0，每步上报一次'
      async execute() { this.processingResultReport({ at: this.input }); return this.input - 1 }
    }
    class CountDownPipe extends PipelineHandler {
      name = 'countDownPipe'
      description = '数到 0 为止'
      next(lastResult) {
        if (lastResult === undefined) return { task: 'countDown', input: this.event.payload.from }
        if (lastResult <= 0) return { task: '$terminal', input: { reached: 0 } }
        return { task: 'countDown', input: lastResult }
      }
    }
    const naceb = new NACEB({ pipelineHandlers: [new CountDownPipe()], taskHandlers: [new CountDown()],
      eventAlias: [{ eventName: 'countdown', pipelineName: 'countDownPipe', description: '数到 0' }] })
    const nacab = new NACAB()
    nacab.register({ name: 'math.add', description: '两数相加', execute: p => p.a + p.b })
    app = useProviders(new NApp({ id: 'core', server: cfg }))
    app.bindProcessor('event', naceb.nacpAdaptor)
    app.bindProcessor('ability', nacab.nacpAdaptor)
  } else {
    app = useProviders(new NApp({ id: cfg.id, server: cfg.server ?? [], opt: cfg.opt }))
    app.bindProcessor('event', makeNaceb().nacpAdaptor)
    app.bindProcessor('ability', makeNacab().nacpAdaptor)
  }
  await app.start()
  const reply = (id, body) => process.send(mode === 'simple' ? body : { id, ...body })
  process.on('message', async m => {
    try {
      switch (m.cmd) {
        case 'emit': app.bus.emit(m.key, m.payload); if (mode !== 'simple') reply(m.id, { ok: true }); return
        case 'peers': return reply(m.id, { peers: app.listConnectedApp() })
        case 'decl': return reply(m.id, { decl: app.buildDecl() })
        case 'subcount': return reply(m.id, { subs: app.nacp.getSubCount(), listens: app.nacp.getListenCount() })
        case 'connect': await app.connect(m.expect, m.spec); return reply(m.id, { ok: true })
        case 'disconnect': return reply(m.id, { dropped: await app.disconnect(m.appId) })
        case 'request': {
          const res = await app.request(m.to, m.opt).response
          return reply(m.id, { ok: true, payload: res.payload })
        }
        case 'bye': await app.terminate(); process.exit(0)
      }
    } catch (e) { reply(m.id, { error: e?.code ?? e?.message ?? String(e) }) }
  })
  process.send({ ready: true })
}

if (process.argv[2] === '--test-peer') await runTestPeer(process.argv[3], JSON.parse(process.argv[4]))
