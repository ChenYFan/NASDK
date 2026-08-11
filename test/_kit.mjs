/**
 * Shared kit for full/ and edge/. Deliberately NOT used by simple/ — those files are read as examples, so an
 * indirection there would cost more than the duplication saves.
 *
 * Ports are a FIXED table keyed by name. Not a counter: `node:test` runs each file in its own process, so a
 * counter restarts at zero per file and two suites collide. A name maps to the same port every run, so a
 * stranded port points at exactly one test.
 */

import NApp from '../index.ts'
import { NACEB, PipelineHandler, TaskHandler } from '../NACEB/index.ts'
import { NACAB } from '../NACAB/index.ts'

// ── addresses ──────────────────────────────────────────────────────────────────────────────────────────
// 18900-18999 reserved for NASDK tests; simple/ owns 189 0x, full/ 191x-193x, edge/ 195x-197x.
export const PORT = {
  napp: 18910, nappB: 18911, nappC: 18912, nappGw: 18913, nappGw2: 18914,
  nacp: 18920, nact: 18921, nactWs: 18922,
  edge: 18950, edgeB: 18951, edgeWs: 18952, edgeChunk: 18953, edgeMany: 18954, edgeDead: 18955,
}

/** A unix socket path unique to this process AND this name, so concurrent runs never share one. */
export const sock = (name) => `/tmp/nasdk-t-${name}-${process.pid}.sock`

export const tcp = (port, opt = {}) => ({ type: 'tcp', opt: { ip: '127.0.0.1', port, ...opt } })
export const ws = (port, opt = {}) => ({ type: 'ws', opt: { ip: '127.0.0.1', port, path: '/ws', ...opt } })
export const unix = (name, opt = {}) => ({ type: 'unix', opt: { socketPath: sock(name), ...opt } })

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
  const app = new NApp({ id, server, opt })
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
  const app = new NApp({ id, opt })
  await app.start()
  return app
}

// ── fake peers (layer tests never open a socket) ────────────────────────────────────────────────────────

/**
 * A Peer that records what NACP hands it and answers the four handshake types with an isOk response.
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
    send(msg) {
      sent.push(msg)
      if (!answer) return
      if (msg.type === 'register' || msg.type === 'unregister'
        || msg.type === 'subscribe' || msg.type === 'unsubscribe') {
        // Microtask, not sync: a real ack always lands on a later turn, and answering inside `send` would let
        // the response arrive before the sender finished filing its pending entry.
        queueMicrotask(() => app.nacp.inbound({
          v: msg.v, type: 'response', id: `ack-${msg.id}`, from: msg.to, to: msg.from, t: Date.now(),
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
    v: v ?? { major: 1, minor: 0 }, type, id: id ?? `m-${++seq}`,
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
