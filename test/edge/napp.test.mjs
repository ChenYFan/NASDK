/**
 * edge/napp — 联测的临界与压力。真进程、真 socket。
 *
 * full/napp 覆盖门面正常路径，这里挑规模与退化：NotifyStream 的缓冲与溢出（返回 tuple 而非单 promise
 * 的全部理由）、大量 notify 的吞吐、订阅在 break 时的取消、terminate 的道别时序。
 *
 * 对端跑在 full 的 ./_peer.mjs 里。性能只打印。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import NApp from '../../index.ts'
import { NOTIFY_BUFFER_MAX } from '../../NApp/notifyStream.ts'
import { NAppInternal } from '../../NApp/events.ts'
import { makeNaceb, makeNacab, tcp, unix, PORT, sleep, timed } from '../_kit.mjs'

const SLOW = !!process.env.NASDK_SLOW
const PEER = fileURLToPath(new URL('../full/_peer.mjs', import.meta.url))

async function spawnPeer(cfg) {
  const child = fork(PEER, [JSON.stringify(cfg)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (c) => reject(new Error(`对端进程提前退出 code=${c}`)))
  })
  let seq = 0
  const ask = (cmd, extra = {}) => new Promise((resolve) => {
    const id = ++seq
    const onMsg = (m) => { if (m.id === id) { child.off('message', onMsg); resolve(m) } }
    child.on('message', onMsg)
    child.send({ cmd, id, ...extra })
  })
  return {
    child, ask,
    emit: (key, payload) => ask('emit', { key, payload }),
    stop: async () => {
      if (child.exitCode !== null) return
      child.send({ cmd: 'bye' })
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000) })
    },
  }
}

/** 起一个本地 App，绑好默认 Processor，连到对端。 */
async function localApp(id, expect, spec, opt) {
  const app = new NApp({ id, opt })
  app.bindProcessor('event', makeNaceb().nacpAdaptor)
  app.bindProcessor('ability', makeNacab().nacpAdaptor)
  await app.start()
  await app.connect(expect, spec)
  return app
}

// ── NotifyStream 缓冲 ──

test('订阅期间到达的 notify 会被缓冲，消费者晚到也不丢', async () => {
  const spec = tcp(PORT.edgeDead)
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec, { queueMaxCount: 16 })

  const { response, stream } = app.subscribe('srv', 'topic:buffered')
  await response                                  // 订阅确立

  // 对端连发 10 条，此时本地还没开始迭代 stream
  for (let i = 0; i < 10; i++) await peer.emit('topic:buffered', { i })
  await sleep(150)                                // 全部到达并缓冲

  // 现在才开始消费 —— 一条都不该少
  const got = []
  for await (const message of stream) {
    got.push(message.payload.i)
    if (got.length === 10) break
  }
  assert.deepEqual(got, [...Array(10).keys()], '晚到的消费者拿到了全部缓冲内容，顺序不乱')

  await app.terminate()
  await peer.stop()
})

test('缓冲上限：超过 NOTIFY_BUFFER_MAX 丢最老的，发 notifyWarning', async () => {
  // NotifyStream 单独测（不走网络）：直接 push 到溢出，观察丢弃策略与告警。
  const { NotifyStream } = await import('../../NApp/notifyStream.ts')
  let warned = 0
  const stream = new NotifyStream({ onOverflow: () => warned++, onCancel: () => {} })

  const N = NOTIFY_BUFFER_MAX + 500
  for (let i = 0; i < N; i++) stream.push({ i })
  assert.equal(stream.pending, NOTIFY_BUFFER_MAX, `缓冲封顶在 ${NOTIFY_BUFFER_MAX}`)
  assert.equal(warned, 500, '每丢一条最老的告警一次')

  // 读出来的应该是最新的那 1024 条（最老的 500 条被丢了）
  const first = await stream[Symbol.asyncIterator]().next()
  assert.equal(first.value.i, 500, '队首是第 500 条 —— 前面的被挤掉了')
})

test('NApp 层：不消费的订阅溢出后发 napp:internal:notify:warning', async () => {
  const spec = tcp(PORT.edgeDead + 1)
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec)

  const warns = []
  app.bus.listen(NAppInternal.notifyWarning, (p) => warns.push(p))

  const { response, stream } = app.subscribe('srv', 'topic:flood')
  await response
  // 故意不迭代 stream，让它涨到溢出
  const N = NOTIFY_BUFFER_MAX + 200
  const [, ms] = await timed(async () => { for (let i = 0; i < N; i++) await peer.emit('topic:flood', { i }) })
  await sleep(200)

  assert.ok(warns.length > 0, `溢出发了告警，实得 ${warns.length} 条`)
  console.log(`    ${N} 条 notify 灌满不消费的流: ${ms.toFixed(0)}ms, 告警 ${warns.length} 条`)

  // 取消订阅收尾（否则 stream 一直挂着）。return 在迭代器上，不在 stream 实例上。
  await stream[Symbol.asyncIterator]().return()
  await app.terminate()
  await peer.stop()
})

// ── notify 吞吐 ──

test('2000 条 notify 全程消费，不丢不乱', async () => {
  const spec = unix('edge-napp-flow')
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec)

  const { response, stream } = app.subscribe('srv', 'stream:seq')
  await response

  const N = 2000
  const got = []
  const consume = (async () => {
    for await (const message of stream) { got.push(message.payload.i); if (got.length === N) break }
  })()

  const [, ms] = await timed(async () => { for (let i = 0; i < N; i++) await peer.emit('stream:seq', { i }) })
  await consume

  assert.equal(got.length, N)
  assert.deepEqual(got, [...Array(N).keys()], '2000 条顺序完整')
  console.log(`    2000 条 notify 端到端: ${ms.toFixed(0)}ms (${(N / (ms / 1000)).toFixed(0)} notify/s)`)

  await app.terminate()
  await peer.stop()
})

test('break 出迭代 = 取消订阅：对端订阅记录被清', async () => {
  const spec = unix('edge-napp-cancel')
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec)

  const { response, stream } = app.subscribe('srv', 'stream:cancel')
  await response
  const before = (await peer.ask('subcount')).subs
  assert.ok(before >= 1, `对端有订阅记录，实得 ${before}`)

  // 收一条就 break —— break 应触发 stream 的 onCancel → unsubscribe
  await peer.emit('stream:cancel', { hi: 1 })
  for await (const _ of stream) break
  await sleep(150)

  const after = (await peer.ask('subcount')).subs
  assert.equal(after, before - 1, 'break 出去把对端那条订阅也退了')

  await app.terminate()
  await peer.stop()
})

// ── 并发订阅 ──

test('100 条并发订阅同一对端，各收各的', async () => {
  const spec = unix('edge-napp-multisub')
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec)

  const N = 100
  const streams = []
  const subs = []
  for (let i = 0; i < N; i++) {
    const { response, stream } = app.subscribe('srv', `multi:${i}`)
    subs.push(response); streams.push(stream)
  }
  await Promise.all(subs)

  // 每条流收自己那个 topic 的一条
  const got = new Array(N).fill(null)
  const consumers = streams.map((s, i) => (async () => {
    for await (const message of s) { got[i] = message.payload.v; break }
  })())

  for (let i = 0; i < N; i++) await peer.emit(`multi:${i}`, { v: i })
  await Promise.all(consumers)

  assert.deepEqual(got, [...Array(N).keys()], '100 条流各收到自己 topic 的值，不串')
  await app.terminate()
  await peer.stop()
})

// ── 生命周期 ──

test('terminate 时先道别再断线：对端能观察到 unregister', async () => {
  const spec = tcp(PORT.edgeDead + 2)
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec)

  assert.deepEqual((await peer.ask('peers')).peers, ['cli'], '对端认识 cli')

  await app.terminate()
  await sleep(200)
  // terminate 的硬顺序：先发 unregister，再拆 NACP/NACT。所以对端应当已经把 cli 移出。
  assert.deepEqual((await peer.ask('peers')).peers, [], '道别到了，对端把 cli 清了 —— 不是等 socket 断才发现')

  await peer.stop()
})

test('terminate 后所有出站方法立刻失败，不是超时', async () => {
  const spec = unix('edge-napp-stopping')
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec)
  await app.terminate()

  // stopping 闩一旦落下就不可逆，出站方法应当同步抛/立刻 reject
  const [, ms] = await timed(async () => {
    await assert.rejects(() => app.request('srv', { kind: 'ability', target: 'add', payload: {} }).response)
  })
  assert.ok(ms < 500, `stopping 后立刻失败而不是等超时，实测 ${ms.toFixed(1)}ms`)

  await peer.stop()
})

test('对端进程猝死：本地 pending 在重连宽限到期后 reject', async () => {
  const spec = tcp(PORT.edgeDead + 3)
  const peer = await spawnPeer({ id: 'srv', server: [spec] })
  const app = await localApp('cli', 'srv', spec, { reconnectGraceMs: 50 })

  // 挂一个对端不会答的 request（对端没有 'never' 这个 ability，但我们不 await 结果，只看断线时的反应）
  const pending = app.request('srv', { kind: 'ability', target: 'slow', payload: { ms: 60000 } }).response.catch(e => e)
  await sleep(50)

  // 直接杀对端进程（不是优雅 bye）
  peer.child.kill('SIGKILL')
  const [err, ms] = await timed(() => pending)
  assert.ok(err instanceof Error, '对端猝死后 pending 被 reject')
  assert.ok(ms >= 40 && ms < 3000, `应在 50ms 宽限到期后 reject，实测 ${ms.toFixed(0)}ms`)
  console.log(`    对端 SIGKILL 后宽限到期 reject: ${ms.toFixed(0)}ms`)

  await app.terminate().catch(() => {})
})
