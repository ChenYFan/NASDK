/**
 * Shared test kit — port/socket allocation, App assembly shorthands, and timing.
 *
 * Ports are FIXED high numbers, handed out by name from one table below. One table rather than a counter,
 * because `node:test` runs files in separate processes: a counter would restart at zero in each file and two
 * suites would collide. A name maps to the same port every run, so a leaked port points at exactly one test.
 *
 * Every helper that opens something returns a `stop()`. Tests must call it — a lingering server keeps its port
 * bound and the NEXT run of the same test fails, which is a confusing way to learn you forgot teardown.
 */

import NApp from '../index.ts'
import { NACEB, PipelineHandler, TaskHandler } from '../NACEB/index.ts'
import { NACAB } from '../NACAB/index.ts'

// ── addresses ──────────────────────────────────────────────────────────────────────────────────────────
// 18900-18999 reserved for NASDK tests. Each suite owns a decade so a crashed run cannot strand a port
// another suite needs.
export const PORT = {
  // simple
  simpleTcp: 18900, simpleWs: 18901,
  // full
  fullTcp: 18910, fullWs: 18911, fullTcpB: 18912, fullWsB: 18913, fullGw: 18914,
  fullTcpC: 18915, fullWsC: 18916,
  // edge
  edgeTcp: 18930, edgeWs: 18931, edgeChunk: 18932, edgeMany: 18933, edgeHb: 18934,
  edgeDead: 18935, edgeBig: 18936,
}

/** A unix socket path unique to this process, so two concurrent runs never share one. */
export function sock(name) {
  return `/tmp/nasdk-test-${name}-${process.pid}.sock`
}

export const tcp = (port, opt = {}) => ({ type: 'tcp', opt: { ip: '127.0.0.1', port, ...opt } })
export const ws = (port, opt = {}) => ({ type: 'ws', opt: { ip: '127.0.0.1', port, path: '/ws', ...opt } })
export const unix = (name, opt = {}) => ({ type: 'unix', opt: { socketPath: sock(name), ...opt } })

// ── handlers ───────────────────────────────────────────────────────────────────────────────────────────

/** A task that reports N process chunks then returns. The one shape most tests need: it makes the process
 *  stream observable and countable without depending on any real work. */
export class Emit extends TaskHandler {
  name = 'emit'
  description = 'report n chunks then return'
  async execute() {
    const n = this.input?.n ?? 3
    for (let i = 0; i < n; i++) this.processingResultReport({ i })
    return { emitted: n }
  }
}

/** A task that never settles until released. Lets a test hold an event mid-flight and inspect state. */
export class Hang extends TaskHandler {
  name = 'hang'
  description = 'block until released'
  async execute() { return new Promise((r) => { HANG_RELEASE.push(r) }) }
}
export const HANG_RELEASE = []
export const releaseHang = (value = 'released') => { while (HANG_RELEASE.length) HANG_RELEASE.shift()(value) }

/** A task that throws — for the failure path. */
export class Boom extends TaskHandler {
  name = 'boom'
  description = 'always throws'
  async execute() { throw new Error(this.input?.msg ?? 'boom') }
}

/** One-step pipeline: run `task` (default 'emit') once with the event payload, then terminate with its result. */
export class OneStep extends PipelineHandler {
  name = 'oneStep'
  description = 'run one task then terminate'
  next(last) {
    if (last === undefined) return { task: this.event.payload?.task ?? 'emit', input: this.event.payload }
    return { task: '$terminal', input: last }
  }
}

/** Build a NACEB exposing event name `run` over the OneStep pipeline. */
export function makeNaceb() {
  return new NACEB({
    pipelineHandlers: [new OneStep()],
    taskHandlers: [new Emit(), new Hang(), new Boom()],
    eventAlias: [{ eventName: 'run', pipelineName: 'oneStep', description: 'run one task' }],
  })
}

/** Build a NACAB with a few plain abilities. */
export function makeNacab() {
  const nacab = new NACAB()
  nacab.register({ name: 'add', description: 'a+b', execute: (p) => p.a + p.b })
  nacab.register({ name: 'echo', description: 'echo', execute: (p) => p })
  nacab.register({ name: 'fail', description: 'throws', execute: () => { throw new Error('ability failed') } })
  return nacab
}

// ── apps ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Assemble + start an App. Both processors are bound unless `bind:false` — an App with neither still works
 * (start() auto-binds stock ones), but most tests want the kit's handlers.
 *
 * Returns the App plus the naceb/nacab actually bound, because a test that asserts on processor-internal
 * observation needs the instance, not just the adaptor.
 */
export async function startApp(id, { server = [], bind = true, opt } = {}) {
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

/** The pair almost every test opens: a server App and a client App already registered with it. */
export async function startPair(spec, { serverId = 'srv', clientId = 'cli', serverOpt, clientOpt } = {}) {
  const s = await startApp(serverId, { server: [spec], opt: serverOpt })
  const c = await startApp(clientId, { opt: clientOpt })
  await c.app.connect(serverId, spec)
  return {
    srv: s.app, cli: c.app, naceb: s.naceb, nacab: s.nacab,
    cliNaceb: c.naceb, cliNacab: c.nacab,
    stop: async () => { await c.stop(); await s.stop() },
  }
}

// ── fake peers (for the layer unit tests: nacp/nact never open a socket) ────────────────────────────────
//
// NACP addresses connections through `napp.nact.sendToPeer(peerId, msg)`, and a Peer is only {id, send, close,
// terminate?}. So a unit test can put an object of its own in the peer table and read every frame NACP tries
// to emit, with no carrier, no port, and no async at all.
//
//   const app = await startBare('me')
//   const { peer, sent } = fakePeer(app, 'p1')
//   app.nact.addPeer(peer); app.nacp.bindAppId('them', 'p1')
//   app.nacp.notify('them', {...})       // → lands in `sent`

/**
 * A Peer that records what NACP hands it AND answers the four handshake types with an isOk response.
 *
 * The auto-answer is not cosmetic. `NApp.terminate()` sends an unregister to every bound appId and awaits the
 * acknowledgement; a peer that only records never answers, so teardown waits out the full 10s
 * RESPONSE_TIMEOUT_MS. Measured: 10007ms per test without this, 0.5ms with it. Since every layer test tears an
 * App down, a silent fake peer would make the unit suites ~20000× slower for no added coverage.
 *
 * Pass `answer:false` when the test is specifically about what happens when a peer goes silent — then the
 * timeout IS the thing under test, and it should be reached deliberately rather than by accident.
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
        // Microtask, not sync: a real ack always arrives on a later turn, and answering inside `send` would
        // let a response land before the sender finished filing its pending entry.
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

/** An App with NO server entry and NO processors bound beyond the stock ones start() settles. The base for a
 *  layer unit test: it exists so `app.nacp` / `app.nact` have a host, and it listens to nothing. */
export async function startBare(id, opt) {
  const app = new NApp({ id, opt })
  await app.start()
  return app
}

/** Hand-build an inbound message. Layer tests feed these to `nacp.inbound()` directly, which is the only way
 *  to exercise a receive path (a malformed frame, an unknown subscription) that a cooperating peer never sends. */
export function msg(type, { from = 'other', to = 'me', id = `m-${++msgSeq}`, meta = {}, payload = {} } = {}) {
  return { v: { major: 1, minor: 0 }, type, id, from, to, t: Date.now(), meta, payload }
}
let msgSeq = 0

/** A register message with the payload NACP actually reads. */
export const registerMsg = (o = {}) => msg('register', {
  ...o,
  payload: { isGateway: false, decl: { events: [], abilities: [] }, ...(o.payload ?? {}) },
})

// ── misc ───────────────────────────────────────────────────────────────────────────────────────────────

/** Time an async fn. Returns [result, ms]. edge/ prints these; nothing asserts on them. */
export async function timed(fn) {
  const t0 = performance.now()
  const out = await fn()
  return [out, performance.now() - t0]
}

/** Format a throughput line for edge/ output. */
export function rate(label, bytes, ms) {
  const mb = bytes / 1024 / 1024
  return `${label}: ${mb.toFixed(2)}MB in ${ms.toFixed(1)}ms = ${(mb / (ms / 1000)).toFixed(1)}MB/s`
}

/** Resolve after `ms`. Used where a test must let the event loop turn (a notify racing a teardown, say). */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Await one bus event, with a timeout so a missing event fails loudly instead of hanging the suite. */
export function waitFor(bus, key, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off(id); reject(new Error(`waitFor('${key}') timed out after ${ms}ms`)) }, ms)
    const id = bus.listen(key, (payload) => { clearTimeout(timer); bus.off(id); resolve(payload) })
  })
}

/** Collect every event matching `key` until `stop()` is called. Returns {events, stop}. */
export function collect(bus, key) {
  const events = []
  const id = bus.listen(key, (payload) => events.push(payload))
  return { events, stop: () => bus.off(id) }
}
