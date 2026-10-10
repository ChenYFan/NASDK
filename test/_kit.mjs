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
import { fork } from 'node:child_process'
import { createHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setImmediate as flush } from 'node:timers/promises'
import { packFrameHeader } from '../NACT/framing.ts'
import HTTPClient from '../packages/nact-streamable-http-client/index.ts'
import HTTPServer from '../packages/nact-streamable-http-server/index.ts'
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
        case 'emitBatch': {
          for (let i = 0; i < m.count; i++) {
            app.bus.emit(m.key, { i, data: new Uint8Array(m.size ?? 0) })
            if (i % 32 === 31) await flush()
          }
          return reply(m.id, { ok: true })
        }
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

export function benchMeter({ noDelay = false } = {}) {
  const delay = monitorEventLoopDelay({ resolution: 10 })
  let cpu, clock, elu, timer, lastSample, lastPublish = 0
  const meter = { txBytes: 0, rxBytes: 0, txFrames: 0, rxFrames: 0, writePeakBytes: 0,
    rssPeakBytes: 0, arrayBuffersPeakBytes: 0, heapPeakBytes: 0, warnings: {} }
  const channels = new Set()
  const sample = () => {
    const memory = process.memoryUsage()
    meter.rssPeakBytes = Math.max(meter.rssPeakBytes, memory.rss)
    meter.arrayBuffersPeakBytes = Math.max(meter.arrayBuffersPeakBytes, memory.arrayBuffers)
    meter.heapPeakBytes = Math.max(meter.heapPeakBytes, memory.heapUsed)
    if (clock !== undefined && performance.now() - lastSample >= 1000) {
      lastSample = performance.now()
      meter.samples.push({ seconds: (lastSample - clock) / 1000, rssBytes: memory.rss,
        arrayBuffersBytes: memory.arrayBuffers, heapBytes: memory.heapUsed, txBytes: meter.txBytes, rxBytes: meter.rxBytes })
    }
    let queued = 0
    for (const channel of channels) queued += channel.socket?.writableLength ?? channel.socket?.bufferedAmount ?? 0
    meter.writePeakBytes = Math.max(meter.writePeakBytes, queued)
    if (process.env.NASDK_METRICS_URL && clock !== undefined && performance.now() - lastPublish >= 1000) {
      lastPublish = performance.now()
      void fetch(`${process.env.NASDK_METRICS_URL}/ingest`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labels: meter.labels ?? { role: process.argv[2] === '--bench-peer' ? 'server' : 'client' },
          values: { rss_bytes: memory.rss, array_buffers_bytes: memory.arrayBuffers, write_queue_bytes: queued,
            tx_bytes_total: meter.txBytes, rx_bytes_total: meter.rxBytes,
            heap_bytes: memory.heapUsed, cpu_percent: (() => { const c = process.cpuUsage(cpu); return (c.user + c.system) / ((performance.now() - clock) * 10) })(),
            event_loop_utilization: performance.eventLoopUtilization(elu).utilization } }),
        signal: AbortSignal.timeout(1000) }).catch(() => {})
    }
  }
  meter.instrument = app => {
    for (const name of ['ackWarning', 'ackError', 'backlogWarning', 'routeError', 'notifyError']) {
      app.bus.listen(`nacp:internal:${name.replace(/([A-Z])/g, ':$1').toLowerCase()}`, payload => {
        meter.warnings[name] = (meter.warnings[name] ?? 0) + 1
        const reason = `${name}:${payload.reason ?? 'unknown'}`
        meter.warnings[reason] = (meter.warnings[reason] ?? 0) + 1
      })
    }
    for (const Provider of [TCPServerProvider, TCPClientProvider, UnixServerProvider, UnixClientProvider,
      WebSocketServerProvider, WebSocketClientProvider, HTTPServer, HTTPClient]) {
      const provider = new Provider()
      const wrap = channel => {
        channel.onError(error => {
          const key = `transportError:${error?.code ?? error?.message ?? String(error)}`
          meter.warnings[key] = (meter.warnings[key] ?? 0) + 1
        })
        if (noDelay) channel.socket?.setNoDelay?.(true)
        channels.add(channel)
        channel.onClose(() => channels.delete(channel))
        const send = channel.send.bind(channel), receive = channel.onReceive.bind(channel)
        channel.send = frame => {
          meter.txFrames++
          meter.txBytes += frame.reduce((n, bytes) => n + bytes.byteLength, 0)
          const result = send(frame)
          meter.writePeakBytes = Math.max(meter.writePeakBytes,
            channel.socket?.writableLength ?? channel.socket?.bufferedAmount ?? 0)
          return result
        }
        channel.onReceive = handler => receive(frame => {
          meter.rxFrames++
          meter.rxBytes += frame.reduce((n, bytes) => n + bytes.byteLength, 0)
          handler(frame)
        })
        return channel
      }
      if (provider.role === 'client') {
        const dial = provider.dial.bind(provider)
        provider.dial = async opt => wrap(await dial(opt))
      } else {
        const listen = provider.listen.bind(provider)
        provider.listen = (opt, accept) => listen(opt, channel => accept(wrap(channel)))
      }
      app.nact.use(provider)
    }
    return app
  }
  meter.start = () => {
    for (const key of ['txBytes', 'rxBytes', 'txFrames', 'rxFrames', 'writePeakBytes', 'rssPeakBytes', 'arrayBuffersPeakBytes', 'heapPeakBytes']) meter[key] = 0
    meter.warnings = {}
    meter.rssStartBytes = process.memoryUsage().rss
    meter.arrayBuffersStartBytes = process.memoryUsage().arrayBuffers
    cpu = process.cpuUsage(); clock = performance.now(); elu = performance.eventLoopUtilization()
    lastSample = clock; meter.samples = []
    delay.reset(); delay.enable(); sample()
    timer = setInterval(sample, 100)
  }
  meter.stop = () => {
    clearInterval(timer); sample(); delay.disable()
    const used = process.cpuUsage(cpu), elapsedMs = performance.now() - clock
    return { ...Object.fromEntries(Object.entries(meter).filter(([, value]) => typeof value !== 'function')),
      rssEndBytes: process.memoryUsage().rss, heapEndBytes: process.memoryUsage().heapUsed,
      arrayBuffersEndBytes: process.memoryUsage().arrayBuffers,
      cpuPercent: (used.user + used.system) / (elapsedMs * 10),
      eventLoopUtilization: performance.eventLoopUtilization(elu).utilization,
      eventLoopP99Ms: delay.percentile(99) / 1e6 }
  }
  return meter
}

export async function benchPeer(t, spec, noDelay = false, topology = {}) {
  const child = fork(new URL('./_kit.mjs', import.meta.url), ['--bench-peer', JSON.stringify(spec), String(noDelay), JSON.stringify(topology)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  t.after(async () => {
    if (child.exitCode !== null) return
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.send({ cmd: 'bye' })
    })
  })
  await new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject)
    child.once('exit', code => reject(new Error(`benchmark peer exited: ${code}`)))
  })
  let seq = 0
  return { child, ask: (cmd, extra = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const cleanup = () => { child.off('message', receive); child.off('exit', exit); clearTimeout(timer) }
    const receive = message => {
      if (message.id !== id) return
      cleanup()
      if (message.error) reject(new Error(message.error))
      else resolve(message)
    }
    const exit = code => { cleanup(); reject(new Error(`benchmark peer exited: ${code}`)) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`benchmark IPC timeout: ${cmd}`)) }, 30000)
    child.on('message', receive); child.once('exit', exit); child.send({ cmd, id, ...extra })
  }) }
}

export function benchSteps(value) {
  if (value === undefined || value.trim() === '') return undefined
  const steps = value.split(',').map(Number)
  if (steps.some(step => !Number.isSafeInteger(step) || step < 1)) throw new Error('Invalid VU steps')
  return steps
}

export async function benchGatewayUsers(t, spec, users, links, meter) {
  const apps = []
  t.after(async () => {
    for (const app of apps) app.nacp.terminate()
    await Promise.all(apps.map(app => app.nact.terminate()))
  })
  for (let i = 0; i < users; i++) {
    const app = meter.instrument(new NApp({ id: `bench-user-${i}`, opt: { heartbeatIntervalMs: false,
      ackTimeoutMs: 10000, reconnectGraceMs: 100, queueMaxCount: Number(process.env.NASDK_CAPACITY_QUEUE_MAX_COUNT || 1024) } }))
    apps.push(app); await app.start()
    for (let link = 0; link < links; link++) await app.connect(`bench-gateway-${link}`, spec)
    if ((i + 1) % 256 === 0) console.log(`USERS connected ${i + 1}/${users}`)
  }
  return apps
}

export function benchLoadConfig(connections, cfg) {
  const vus = cfg.vus ?? connections
  const vuInflight = cfg.vuInflight ?? (cfg.vus === undefined ? cfg.inflight ?? 1 : 1)
  for (const value of [connections, vus, vuInflight]) assert.ok(Number.isSafeInteger(value) && value > 0, 'invalid load dimensions')
  const totalInflight = vus * vuInflight
  assert.ok(Number.isSafeInteger(totalInflight), 'in-flight limit exceeds safe integer range')
  return { vus, vuInflight, totalInflight, connections, usedConnections: Math.min(vus, connections),
    maxInflightPerConnection: Math.ceil(vus / connections) * vuInflight }
}

export async function benchRequests(apps, cfg, seconds) {
  const load = benchLoadConfig(apps.length, cfg)
  if (cfg.topology === 'gateway-mux') Object.assign(load, { connections: apps.length * cfg.userLinks,
    usedConnections: apps.length, upstreamConnections: 1, users: apps.length })
  const histogram = createHistogram()
  const data = Uint8Array.from({ length: cfg.size }, (_, i) => i & 255)
  const errors = {}, started = performance.now(), deadline = started + seconds * 1000
  let seq = 0, completed = 0, failed = 0, stop = false, missed = 0, active = 0
  const bounds = [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5, 15]
  const buckets = bounds.map(() => 0)
  let sum = 0
  const publish = () => {
    if (!process.env.NASDK_METRICS_URL) return
    void fetch(`${process.env.NASDK_METRICS_URL}/ingest`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: { role: 'load', provider: cfg.provider, mode: cfg.mode,
        size: cfg.size, ...load, ...(process.env.NASDK_BENCH_RUN && { run: process.env.NASDK_BENCH_RUN }),
        ...(process.env.NASDK_BENCH_SHA && { git: process.env.NASDK_BENCH_SHA }),
        model: cfg.rate ? 'arrival' : 'closed', stage: cfg.stage ?? 'measurement' },
        values: { completed_total: completed, failed_total: failed, missed_total: missed,
          useful_bytes_total: completed * cfg.size * (cfg.mode === 'echo' ? 2 : 1), target_rate: cfg.rate ?? 0,
          configured_vus: load.vus, configured_connections: load.connections, active_requests: active,
          inflight_limit: load.totalInflight },
        histogram: { bounds, buckets, count: completed, sum } }), signal: AbortSignal.timeout(1000) }).catch(() => {})
  }
  const metricTimer = setInterval(publish, 1000)
  const request = async app => {
    const id = seq++, begin = performance.now()
    try {
      const response = await app.request('bench-server', {
        kind: 'ability', target: `bench.${cfg.mode}`, payload: { seq: id, data },
      }).response
      if (cfg.topology === 'gateway-mux') {
        assert.equal(response.to, app.id)
        assert.equal(response.from, 'bench-server')
      }
      assert.equal(response.payload.seq, id)
      assert.equal(response.payload.length, data.length)
      if (cfg.mode === 'echo') {
        const bytes = response.payload.data
        assert.ok(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(data), 'echo binary mismatch')
      }
      histogram.record(Math.max(1, Math.round((performance.now() - begin) * 1e6)))
      const seconds = (performance.now() - begin) / 1000
      sum += seconds
      for (let i = 0; i < bounds.length; i++) if (seconds <= bounds[i]) buckets[i]++
      completed++
    } catch (error) {
      failed++
      const code = error.code ?? error.message
      errors[code] = (errors[code] ?? 0) + 1
    }
  }
  // A deadline aborts the whole phase; timed-out calls are never replaced with fresh calls.
  const abort = setTimeout(() => {
    stop = true
    for (const app of apps) { app.nacp.terminate(); void app.nact.terminate() }
  }, seconds * 1000 + 15000)
  try {
    if (cfg.rate) {
      const pending = new Set(), perVuActive = Array(load.vus).fill(0)
      let slot = 0
      while (!stop && performance.now() < deadline) {
        const due = Math.min(Math.floor((performance.now() - started) * cfg.rate / 1000), Math.ceil(seconds * cfg.rate) - 1)
        while (slot <= due && !stop) {
          const index = slot++
          const vu = index % load.vus
          if (perVuActive[vu] >= load.vuInflight) { missed++; continue }
          active++
          perVuActive[vu]++
          const work = request(apps[vu % apps.length]).finally(() => { active--; perVuActive[vu]--; pending.delete(work) })
          pending.add(work)
        }
        // Small caps must not be artificially limited to one batch per millisecond.
        if (cfg.provider === 'nacp-direct') await flush()
        else await sleep(1)
      }
      missed += Math.max(0, Math.ceil(seconds * cfg.rate) - slot)
      await Promise.all(pending)
    } else {
      await Promise.all(Array.from({ length: load.vus }, (_, vu) =>
        Array.from({ length: load.vuInflight }, async () => {
        let count = 0
        while (!stop && performance.now() < deadline) {
          active++
          try { await request(apps[vu % apps.length]) } finally { active-- }
          if (++count % 32 === 0) await flush()
        }
      })).flat())
    }
  } finally { clearTimeout(abort); clearInterval(metricTimer); publish() }
  const elapsedMs = performance.now() - started
  return { ...load, attempted: seq, completed, failed, missed, aborted: stop, errors, elapsedMs,
    msgPerSec: completed / (elapsedMs / 1000),
    usefulMiBPerSec: completed * cfg.size * (cfg.mode === 'echo' ? 2 : 1) / (1024 ** 2 * elapsedMs / 1000),
    latencyMs: { p50: histogram.percentile(50) / 1e6, p95: histogram.percentile(95) / 1e6,
      p99: histogram.percentile(99) / 1e6, max: histogram.max / 1e6 },
  }
}

export async function benchNacpPair(t) {
  const server = new NApp({ id: 'bench-server', opt: { heartbeatIntervalMs: false } })
  const client = new NApp({ id: 'bench-client', opt: { heartbeatIntervalMs: false } })
  const nacab = new NACAB()
  for (const mode of ['sink', 'echo']) nacab.register({ name: `bench.${mode}`, description: mode,
    execute: p => ({ seq: p.seq, length: p.data.byteLength, ...(mode === 'echo' && { data: p.data }) }) })
  server.bindProcessor('ability', nacab.nacpAdaptor)
  await server.start(); await client.start()
  // Direct messages exercise NACP registration, ACK and response without framing/codec/IO.
  const intoServer = { id: 'nacp-server-peer', send: async msg => { queueMicrotask(() => server.nacp.inbound(msg, intoClient)) }, close() {} }
  const intoClient = { id: 'nacp-client-peer', send: async msg => { queueMicrotask(() => client.nacp.inbound(msg, intoServer)) }, close() {} }
  server.nact.addPeer(intoClient); client.nact.addPeer(intoServer)
  server.nact.sendToPeer = async (_id, msg) => { await intoClient.send(msg); return true }
  client.nact.sendToPeer = async (_id, msg) => { await intoServer.send(msg); return true }
  client.nact.dial = async () => intoServer
  await client.connect('bench-server', { type: 'nacp-direct', provider: {} })
  t.after(async () => { await client.terminate(); await server.terminate() })
  return [client]
}

if (process.argv[2] === '--bench-peer') {
  const topology = JSON.parse(process.argv[5] ?? '{}')
  const meter = benchMeter({ noDelay: process.argv[4] === 'true' })
  meter.labels = { role: topology.gateway ? 'gateway' : 'server', provider: JSON.parse(process.argv[3]).type,
    ...(process.env.NASDK_BENCH_RUN && { run: process.env.NASDK_BENCH_RUN }),
    ...(topology.gateway || topology.upstream ? { topology: 'gateway-mux' } : {}) }
  const spec = JSON.parse(process.argv[3])
  const app = meter.instrument(new NApp({ id: topology.gateway ? 'bench-gateway-0' : 'bench-server',
    server: topology.upstream ? [] : [spec],
    opt: { heartbeatIntervalMs: false, ackTimeoutMs: 10000, reconnectGraceMs: 100,
      isGateway: Boolean(topology.gateway), queueMaxCount: Number(process.env.NASDK_CAPACITY_QUEUE_MAX_COUNT || 1024) } }))
  const nacab = new NACAB()
  nacab.register({ name: 'bench.sink', description: 'confirm received bytes',
    execute: p => ({ seq: p.seq, length: p.data.byteLength }) })
  nacab.register({ name: 'bench.echo', description: 'return received bytes',
    execute: p => ({ seq: p.seq, length: p.data.byteLength, data: p.data }) })
  app.bindProcessor('ability', nacab.nacpAdaptor)
  await app.start()
  if (topology.upstream) await app.connect('bench-gateway-0', spec)
  process.on('message', async m => {
    try {
      if (m.cmd === 'bye') { await app.terminate(); process.exit(0) }
      let result = {}
      if (m.cmd === 'peers') result = { peers: app.nact.listPeerId().length }
      if (m.cmd === 'start') { meter.labels = { ...meter.labels, ...m.labels }; meter.start() }
      if (m.cmd === 'stop') result = { metrics: meter.stop(), peers: app.nact.listPeerId().length }
      if (m.cmd === 'notify') {
        const data = new Uint8Array(m.size)
        for (let i = 0; i < m.count; i++) {
          app.bus.emit('bench:notify', { i, data })
          if (i % 32 === 31) await flush()
        }
      }
      process.send({ id: m.id, ...result })
    } catch (e) { process.send({ id: m.id, error: e.message }) }
  })
  process.send({ ready: true })
}
