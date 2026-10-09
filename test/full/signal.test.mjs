// Signal coverage: normal / pause / resume / abort against active event requests.
// parentId points at the original request; the Signal has its own message id.
// Normal Signals stop at PipelineHandler.onNormalSIG; reaching a Task requires an explicit signalTask.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { NACEB, PipelineHandler, TaskHandler, TERMINAL } from '../../NACEB/index.ts'
import { NACAB } from '../../NACAB/index.ts'
import { startApp, startBare, fakePeer, msg, tcp, PORT, sleep, collect } from '../_kit.mjs'

// ── server handlers ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Cooperative long-running task: polls abortSignal and the done flag.
 * On abort the framework has already fired abortSignal before onSignal runs.
 */
class SigTask extends TaskHandler {
  name = 'sigTask'
  description = '响应 Signal 的长跑 task'
  async execute() {
    const ev = this.pipeline.event
    for (let i = 0; i < 600; i++) {
      if (this.abortSignal?.aborted) throw new Error('aborted')
      if (ev.payload.done) return { finished: true, log: ev.payload.log }
      await sleep(5)
    }
    return { finished: false, log: this.pipeline.event.payload.log }
  }
  async onSignal(signal) {
    this.pipeline.event.payload.log.push({ at: 'task', kind: signal.kind, payload: signal.payload ?? null })
    // remote-control semantics: payload.done === true flips the flag so the task finishes early
    if (signal.payload?.done === true) this.pipeline.event.payload.done = true
  }
}

/**
 * Pipeline forwarding normal Signals to the task via signalTask — the only path into a Task.
 * With `forward: false` it only records, pinning "unsupported Task is never called".
 */
class SigPipe extends PipelineHandler {
  name = 'sigPipe'
  description = '跑 sigTask 一步'
  next(last) {
    if (last === undefined) return { task: 'sigTask', input: this.event.payload }
    return { task: TERMINAL, input: last }
  }
  async onNormalSIG(signal) {
    this.event.payload.log.push({ at: 'pipe', kind: signal.kind, payload: signal.payload })
    if (this.event.payload.forward !== false) await this.signalTask(signal)
  }
}

/** Server assembly: event 'job' = sigPipe + sigTask; payload carries { log: [], done: false }. */
function sigNaceb() {
  return new NACEB({
    pipelineHandlers: [new SigPipe()],
    taskHandlers: [new SigTask()],
    eventAlias: [{ eventName: 'job', pipelineName: 'sigPipe', description: '可被 Signal 控制的长跑事件' }],
  })
}

/** Start a pair: server with sigNaceb, connected client. Returns { srv, cli, stop }. */
async function sigPair(port) {
  const s = await startApp('srv', { server: [tcp(port)], bind: false })
  const naceb = sigNaceb()
  s.app.bindProcessor('event', naceb.nacpAdaptor)
  s.app.bindProcessor('ability', new NACAB().nacpAdaptor)
  const c = await startApp('cli')
  await c.app.connect('srv', tcp(port))
  return { srv: s.app, cli: c.app, naceb, stop: async () => { await c.stop(); await s.stop() } }
}

/** Fire a job request (response not awaited); returns the handle. */
const fireJob = (cli, payload = {}) =>
  cli.request('srv', { kind: 'event', target: 'job', payload: { log: [], done: false, ...payload } })

test('Event Request 句柄同步给出 reqId，callback 与 stream 同收首包', async () => {
  const server = await startApp('srv', { server: [tcp(PORT.sigJ)] })
  const client = await startApp('cli')
  await client.app.connect('srv', tcp(PORT.sigJ))
  const callback = []

  const call = client.app.request('srv', {
    kind: 'event', target: 'run', payload: { n: 3 }, onProcess: message => callback.push(message.payload.i),
  })
  assert.equal(typeof call.reqId, 'string')
  assert.ok(call.reqId.length > 0)

  const streamed = []
  for await (const message of call.stream) streamed.push(message.payload.i)
  const response = await call.response

  assert.deepEqual(callback, [0, 1, 2])
  assert.deepEqual(streamed, [0, 1, 2])
  assert.deepEqual(response.payload, { emitted: 3 })
  await client.stop()
  await server.stop()
})

// ── normal ──────────────────────────────────────────────────────────────────────────────────────────────

test('normal Signal：payload 先到 pipeline.onNormalSIG，Pipeline 下发后到 task.onSignal', async () => {
  const { cli, naceb, stop } = await sigPair(PORT.sig)
  const job = fireJob(cli)
  await sleep(80)                                     // let the task actually start
  const runtime = collect(naceb.eventBusObs, 'naceb:runtime:signal:*')

  const ok = await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { hello: 'world' } })
  assert.equal(ok, true, 'Signal 被 ACK')

  const res = await job.response
  assert.equal(res.meta.isOk, true)
  const ats = res.payload.log.map(e => e.at)
  assert.deepEqual(ats, ['pipe', 'task'], 'pipeline 先记、下发后 task 收到')
  assert.deepEqual(res.payload.log[0].payload, { hello: 'world' }, 'pipeline 侧 payload 原样')
  assert.deepEqual(res.payload.log[1].payload, { hello: 'world' }, 'task 侧 payload 原样')
  runtime.stop()
  assert.equal(runtime.events.length, 1)
  assert.equal(runtime.events[0].payload.opt.kind, 'normal')
  assert.equal(runtime.events[0].payload.opt.reqId, job.reqId)

  await stop()
})

test('normal Signal 不带 payload：线上补空对象，task 侧收到 {}', async () => {
  const { cli, stop } = await sigPair(PORT.sigB)
  const job = fireJob(cli)
  await sleep(80)

  assert.equal(await cli.signal('srv', { parentId: job.reqId, kind: 'normal' }), true)

  const res = await job.response
  const taskHit = res.payload.log.find(e => e.at === 'task')
  // buildMessage always emits `opt.payload ?? {}` — envelope payload defaults to an empty object
  assert.deepEqual(taskHit.payload, {}, '没给 payload 时线上是 {}')

  await stop()
})

test('多条 normal Signal 按发送顺序 FIFO 到达', async () => {
  const { cli, stop } = await sigPair(PORT.sigC)
  const job = fireJob(cli)
  await sleep(80)

  for (let i = 0; i < 5; i++) {
    assert.equal(await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { i } }), true)
  }

  const res = await job.response
  const seq = res.payload.log.filter(e => e.at === 'task').map(e => e.payload.i)
  assert.deepEqual(seq, [0, 1, 2, 3, 4], '顺序不乱')

  await stop()
})

test('normal Signal 当遥控器：payload.done=true 让长跑 task 提前收工', async () => {
  const { cli, stop } = await sigPair(PORT.sigD)
  const job = fireJob(cli)
  await sleep(80)

  // onSignal flips the done flag; the task returns on its next poll instead of 600 iterations
  await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { done: true } })

  const res = await job.response
  assert.equal(res.meta.isOk, true)
  assert.equal(res.payload.finished, true, '被信号提前收工')
  assert.ok(res.payload.log.some(e => e.at === 'task' && e.payload.done === true), '信号本身也留了痕')

  await stop()
})

test('Pipeline 不下发时 Task 收不到 —— normal Signal 不自动穿透', async () => {
  const { cli, stop } = await sigPair(PORT.sigE)
  const job = fireJob(cli, { forward: false })         // SigPipe records but does not signalTask
  await sleep(80)

  await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { hello: 1 } })
  await sleep(60)
  await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { done: true } })
  // done flag never flipped (task unreachable); abort to finish instead of waiting 600 polls
  await cli.signal('srv', { parentId: job.reqId, kind: 'abort' })
  await assert.rejects(job.response, () => true)

  await stop()
})

// ── pause / resume ──────────────────────────────────────────────────────────────────────────────────────

test('pause + resume：事件真停住，resume 后重跑并正常 done', async () => {
  const { cli, stop } = await sigPair(PORT.sigF)
  const job = fireJob(cli)
  await sleep(80)

  assert.equal(await cli.signal('srv', { parentId: job.reqId, kind: 'pause' }), true, 'pause ACK')

  // paused: response must not settle (task runs 600×5ms=3s; it would have progressed otherwise)
  const raced = await Promise.race([job.response, sleep(300).then(() => 'STILL-RUNNING')])
  assert.equal(raced, 'STILL-RUNNING', 'paused 期间 response 不 settle')

  assert.equal(await cli.signal('srv', { parentId: job.reqId, kind: 'resume' }), true, 'resume ACK')

  // task restarts from zero (pause keeps no progress); flip the flag to finish
  await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { done: true } })

  const res = await job.response
  assert.equal(res.meta.isOk, true)
  assert.equal(res.payload.finished, true, 'resume 后 task 从头重跑并跑完')
  // pause aborts the task (stopped task is kept for resume — NACEB semantics)
  assert.ok(res.payload.log.some(e => e.at === 'task' && e.kind === 'abort'),
    'pause 时 task 收到的是 abort（stopped 供 resume）')

  await stop()
})

test('pause 期间到达的 normal Signal 仍进 pipeline，stopped 的 task 也收得到下发', async () => {
  const { cli, stop } = await sigPair(PORT.sigG)
  const job = fireJob(cli)
  await sleep(80)

  await cli.signal('srv', { parentId: job.reqId, kind: 'pause' })
  await sleep(60)
  // normal during pause: pipeline.onNormalSIG still fires (event layer doesn't block); the stopped
  // task stays in the controller table and still receives signalTask — but it's stopped, so flipping
  // done has no effect until resume reruns it.
  await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { while: 'paused' } })
  await sleep(60)

  await cli.signal('srv', { parentId: job.reqId, kind: 'resume' })
  await sleep(60)
  // resumed task polls from scratch; flip the flag to finish
  await cli.signal('srv', { parentId: job.reqId, kind: 'normal', payload: { done: true } })

  const res = await job.response
  assert.equal(res.meta.isOk, true)
  const pausedPipe = res.payload.log.find(e => e.at === 'pipe' && e.payload.while === 'paused')
  assert.ok(pausedPipe, 'paused 期间的 normal Signal 进了 pipeline')
  assert.ok(res.payload.log.some(e => e.at === 'task' && e.payload?.while === 'paused'),
    '下发的 signal 也到了（stopped 的 task 仍可被 onSignal 触达）')

  await stop()
})

// ── abort ───────────────────────────────────────────────────────────────────────────────────────────────

test('abort：事件落 failure({error:"aborted"})，请求方 response reject', async () => {
  const { cli, stop } = await sigPair(PORT.sigH)
  const job = fireJob(cli)
  await sleep(80)

  assert.equal(await cli.signal('srv', { parentId: job.reqId, kind: 'abort' }), true, 'abort ACK')

  await assert.rejects(job.response, (e) => {
    assert.equal(e.code, 'response-not-ok')
    return true
  }, 'aborted 事件对请求方表现为失败响应')
  await stop()
})

test('abort 后再 signal 同一 reqId：ACK 仍 true（送达≠处理成功），接收端报 processor-rejected', async () => {
  const { cli, srv, stop } = await sigPair(PORT.sigI)
  const job = fireJob(cli)
  await sleep(80)
  await cli.signal('srv', { parentId: job.reqId, kind: 'abort' })
  await assert.rejects(job.response, () => true)
  await sleep(60)                                     // let the adaptor drop the reqEvents mapping

  // Event already terminal → adaptor.signal throws "no active event" → server reports signalError.
  // Signal ACK means "delivered", not "processed" — so still true.
  const errs = collect(srv.bus, 'nacp:internal:signal:error')
  assert.equal(await cli.signal('srv', { parentId: job.reqId, kind: 'pause' }), true)
  await sleep(50)
  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['processor-rejected'],
    '终局后的 Signal 在接收端落 processor-rejected')
  await stop()
})

// ── protocol details (fakePeer, no socket) ──────────────────────────────────────────────────────────────

test('Signal 信封：meta 带 parentId + kind，normal 的 payload 在顶层，控制类不带 payload key', async () => {
  const app = await startBare('me')
  const { peer, sent } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  await app.nacp.signal('them', { parentId: 'req-9', kind: 'normal', payload: { x: 1 } })
  const sig = sent.find(m => m.type === 'signal')
  assert.ok(sig, '发出了一条 signal')
  assert.equal(sig.meta.parentId, 'req-9', 'parentId 指回原请求')
  assert.equal(sig.meta.kind, 'normal')
  assert.deepEqual(sig.payload, { x: 1 })
  assert.notEqual(sig.id, 'req-9', 'Signal 有自己的 message id')

  sent.length = 0
  await app.nacp.signal('them', { parentId: 'req-9', kind: 'pause' })
  const ctrl = sent.find(m => m.type === 'signal')
  assert.equal(ctrl.meta.kind, 'pause')
  assert.equal('payload' in ctrl, false, '控制类 Signal 不带 payload key')

  await app.terminate()
})

test('Signal 打到未知 appId → 返 false（no-route，不进 ack 等待）', async () => {
  const app = await startBare('lonely')
  assert.equal(await app.nacp.signal('没人', { parentId: 'r', kind: 'normal', payload: {} }), false)
  await app.terminate()
})

test('入站 Signal：先发 nacp:event:{reqId}:signal，再交给 event processor', async () => {
  const app = await startBare('me')
  const { peer } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  const seen = []
  app.bus.listen('nacp:event:req-1:signal', (m) => seen.push(m))

  // default NACEB has no active event for this reqId → adaptor.signal throws → signalError
  const errs = collect(app.bus, 'nacp:internal:signal:error')
  app.nacp.inbound(msg('signal', {
    from: 'them', to: 'me', id: 'sig-1',
    meta: { parentId: 'req-1', kind: 'normal' }, payload: { hi: 1 },
  }), peer)
  await sleep(30)

  assert.equal(seen.length, 1, 'bus 事件先发（无条件，观测面完整）')
  assert.equal(seen[0].meta.kind, 'normal')
  assert.deepEqual(seen[0].payload, { hi: 1 })
  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['processor-rejected'],
    '没有活跃事件 → processor-rejected')
  await app.terminate()
})

test('重复的入站 Signal：再 ACK 但只投递一次（按 signal.id 去重）', async () => {
  const app = await startBare('me')
  const { peer, sent } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  const seen = []
  app.bus.listen('nacp:event:req-1:signal', () => seen.push(1))
  const errs = collect(app.bus, 'nacp:internal:signal:error')

  const dup = msg('signal', {
    from: 'them', to: 'me', id: 'sig-dup',
    meta: { parentId: 'req-1', kind: 'normal' }, payload: {},
  })
  app.nacp.inbound(dup, peer)
  app.nacp.inbound(dup, peer)                         // same signal twice
  await sleep(30)

  assert.equal(seen.length, 1, '业务投递只发生一次')
  assert.equal(sent.filter(m => m.type === 'ack' && m.meta.parentId === 'sig-dup').length, 2,
    '重复的份仍被 ACK（让对端停止重发）')
  errs.stop()
  assert.equal(errs.events.length, 1, '错误也只报一次')
  await app.terminate()
})

test('NACP 1.x register 被 NACP 2.1 以 major version-mismatch 拒绝', async () => {
  const app = await startBare('me')
  const { peer, sent } = fakePeer(app, 'p1', { answer: false })
  app.nact.addPeer(peer)

  app.nacp.inbound(msg('register', {
    from: 'old', to: 'me', id: 'old-register', v: { major: 1, minor: 99 },
    payload: { isGateway: false, decl: { events: [], abilities: [] } },
  }), peer)

  const response = sent.find(m => m.type === 'response')
  assert.equal(response.meta.isOk, false)
  assert.equal(response.meta.whyNotOk, 'version-mismatch')
  await app.terminate()
})
