// Heartbeat integration and lifecycle regressions with controlled peers and clocks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as flush } from 'node:timers/promises'

import NApp from '../../index.ts'
import {
  startApp, tcp, PORT, sleep, waitFor, collect, fakePeer, isHeartbeat, incomingHeartbeat,
  heartbeatClock as clock, makeHeartbeatApp as makeApp, connectHeartbeatPeer as connectPeer,
} from '../_kit.mjs'

const INTERVAL = 300

/** Install before connect(): only the Response matching the first heartbeat completes this wait. */
function firstBeatDone(app) {
  return new Promise((resolve, reject) => {
    let requestId
    const cleanup = () => { clearTimeout(timer); app.bus.off(requestListener); app.bus.off(responseListener) }
    const requestListener = app.bus.listen('nacp:outbound:request', ({ msg }) => {
      if (msg.meta.target === 'NApp.heartbeat' && requestId === undefined) requestId = msg.id
    })
    const responseListener = app.bus.listen('nacp:inbound:response', ({ msg }) => {
      if (msg.meta.parentId === requestId) { cleanup(); resolve(msg) }
    })
    const timer = setTimeout(() => { cleanup(); reject(new Error('first heartbeat Response timed out')) }, 3000)
  })
}

/** Record every outbound heartbeat request: [who, timestamp]. */
function watchBeats(apps) {
  const beats = []
  for (const app of apps) {
    app.bus.listen('nacp:outbound:request', ({ msg }) => {
      if (msg.meta.target === 'NApp.heartbeat') beats.push([app.id, performance.now()])
    })
  }
  return beats
}

test('拨号方先跳，接受方半个周期后回跳，之后两端交替', async () => {
  const spec = tcp(PORT.hb)
  const srv = await startApp('srv', { server: [spec], opt: { heartbeatIntervalMs: INTERVAL } })
  const cli = await startApp('cli', { opt: { heartbeatIntervalMs: INTERVAL } })
  const beats = watchBeats([srv.app, cli.app])

  try {
    await cli.app.connect('srv', spec)
    await sleep(INTERVAL * 2.25)

    const who = beats.map(([id]) => id)
    assert.ok(who.length >= 4, `应有至少 4 次心跳，实得 ${who.length}`)
    who.forEach((id, i) => assert.equal(id, i % 2 === 0 ? 'cli' : 'srv', `第 ${i} 次心跳的发起方：${who.join(',')}`))
    // with equal intervals and prompt replies, the two ends stagger by about half a period
    for (let i = 1; i < beats.length; i++) {
      const gap = beats[i][1] - beats[i - 1][1]
      assert.ok(gap >= INTERVAL * 0.45 && gap < INTERVAL * 0.95, `相邻两次间隔约半个周期，实得 ${gap.toFixed(0)}ms`)
    }
  } finally {
    await cli.stop(); await srv.stop()
  }
})

test('单侧关闭时另一端仍发心跳，关闭方只应答', async () => {
  // dialler disabled: the accepting side starts on its own
  const specA = tcp(PORT.hbB)
  const srvA = await startApp('srv', { server: [specA], opt: { heartbeatIntervalMs: INTERVAL } })
  const cliA = await startApp('cli', { opt: { heartbeatIntervalMs: false } })
  const beatsA = watchBeats([srvA.app, cliA.app])
  try {
    await cliA.app.connect('srv', specA)
    await sleep(INTERVAL * 1.8)
    assert.ok(beatsA.length >= 2, `接受方应自行启动并继续跳，实得 ${beatsA.length}`)
    assert.ok(beatsA.every(([id]) => id === 'srv'), '拨号方一次都没发')
  } finally {
    await cliA.stop(); await srvA.stop()
  }

  // accepting side disabled: only the dialler beats at full periods, the other just answers
  const specB = tcp(PORT.hbC)
  const srvB = await startApp('srv', { server: [specB], opt: { heartbeatIntervalMs: false } })
  const cliB = await startApp('cli', { opt: { heartbeatIntervalMs: INTERVAL } })
  const beatsB = watchBeats([srvB.app, cliB.app])
  try {
    const firstResponse = firstBeatDone(cliB.app)
    await cliB.app.connect('srv', specB)
    await firstResponse
    await sleep(INTERVAL * 1.25)
    assert.ok(beatsB.length >= 2, `拨号方靠自己的整周期继续跳，实得 ${beatsB.length}`)
    assert.ok(beatsB.every(([id]) => id === 'cli'), '接受方一次都没发')
  } finally {
    await cliB.stop(); await srvB.stop()
  }
})

test('两端关闭时都不发心跳', async () => {
  const spec = tcp(PORT.hbE)
  const srv = await startApp('srv', { server: [spec], opt: { heartbeatIntervalMs: false } })
  const cli = await startApp('cli', { opt: { heartbeatIntervalMs: false } })
  const beats = watchBeats([srv.app, cli.app])
  try {
    await cli.app.connect('srv', spec)
    await sleep(INTERVAL * 1.2)
    assert.equal(beats.length, 0)
  } finally {
    await cli.stop(); await srv.stop()
  }
})

test('无 ACK 且 ACK 超时较短：由 NACP 的 ACK 超时判离线', async () => {
  const spec = tcp(PORT.hbD)
  const interval = 300, ackTimeoutMs = 100
  const srv = await startApp('srv', { server: [spec], opt: { heartbeatIntervalMs: false } })
  const cli = await startApp('cli', { opt: { heartbeatIntervalMs: interval, ackTimeoutMs } })
  const inbound = srv.app.nacp.inbound
  try {
    const firstResponse = firstBeatDone(cli.app)
    await cli.app.connect('srv', spec)
    await firstResponse
    assert.deepEqual(cli.app.listConnectedApp(), ['srv'], '第一次心跳正常完成')

    const warnings = collect(cli.app.bus, 'nacp:internal:ack:warning')
    const offline = waitFor(cli.app.bus, 'nacp:internal:napp:success')
    srv.app.nacp.inbound = () => {}                         // physical link stays, peer processes nothing
    const { payload: { msg: heartbeat } } = await waitFor(cli.app.bus, 'nacp:outbound:request')
    assert.equal(heartbeat.meta.target, 'NApp.heartbeat')
    const { payload } = await offline
    assert.equal(payload.reason, 'offline')
    assert.deepEqual(warnings.events.map(({ payload }) => [payload.msg.id, payload.reason]), [[heartbeat.id, 'timeout']])
    assert.deepEqual(cli.app.listConnectedApp(), [])
    assert.equal(cli.app.nacp.getPendingCount(), 0)
    assert.equal(cli.app.nacp.graceTimers.get('srv').hasRef(), false)
  } finally {
    srv.app.nacp.inbound = inbound
    // srv still thinks cli is online: wait for the disconnect before stopping, else stop waits out a 10s handshake timeout
    const gone = waitFor(srv.app.bus, 'nact:peer:disconnect')
    await cli.stop()
    await gone
    await srv.stop()
  }
})

test('心跳已收到 ACK 但未收到 Response：下一周期判离线并清理等待方', async () => {
  const spec = tcp(PORT.hbF)
  const interval = 240
  const srv = await startApp('srv', { server: [spec], opt: { heartbeatIntervalMs: false } })
  const cli = await startApp('cli', { opt: { heartbeatIntervalMs: interval, ackTimeoutMs: 1200 } })
  try {
    const firstResponse = firstBeatDone(cli.app)
    await cli.app.connect('srv', spec)
    await firstResponse
    srv.nacab.register({ name: 'NApp.heartbeat', description: 'stall after receiving the request',
      execute: () => new Promise(() => {}) })

    const warnings = collect(cli.app.bus, 'nacp:internal:ack:warning')
    const offline = waitFor(cli.app.bus, 'nacp:internal:napp:success')
    const { payload: { msg: heartbeat } } = await waitFor(cli.app.bus, 'nacp:outbound:request')
    const t0 = performance.now()
    const { payload: { msg: ack } } = await waitFor(cli.app.bus, 'nacp:inbound:ack')
    assert.equal(ack.meta.parentId, heartbeat.id)
    assert.equal((await offline).payload.reason, 'offline')
    const elapsed = performance.now() - t0
    assert.ok(elapsed >= interval * 0.8 && elapsed < interval * 1.8, `发出后下一周期判离线，实得 ${elapsed}ms`)
    assert.equal(warnings.events.length, 0, '这次离线不是 ACK 超时触发的')
    assert.deepEqual(cli.app.listConnectedApp(), [])
    assert.equal(cli.app.nacp.getPendingCount(), 0, '超时心跳不再占用 Response 等待方')
    assert.equal(cli.app.nacp.graceTimers.get('srv').hasRef(), false)
  } finally {
    const gone = waitFor(srv.app.bus, 'nact:peer:disconnect')
    await cli.stop()
    await gone
    await srv.stop()
  }
})

test('heartbeatIntervalMs 只接受正数或 false', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000'])
    assert.throws(() => new NApp({ id: 'x', opt: { heartbeatIntervalMs: bad } }), (e) => e.code === 'invalid-heartbeat-interval', String(bad))
  assert.doesNotThrow(() => new NApp({ id: 'x', opt: { heartbeatIntervalMs: false } }))
  assert.doesNotThrow(() => new NApp({ id: 'x', opt: { heartbeatIntervalMs: 1 } }))
})

for (const accepting of [false, true]) for (const ack of [true, false]) {
  test(`${accepting ? '接受方' : '拨号方'}重连丢弃旧心跳（${ack ? '已收到' : '未收到'} ACK），新连接重新探测`, async t => {
    const advance = clock(t)
    const app = await makeApp(t)
    const first = await connectPeer(app, 'first', { ack, respond: false, accepting })
    if (accepting) await advance(50)
    const oldRequest = first.heartbeats()[0]
    assert.equal(app.nacp.getPendingCount(), 1)

    app.bus.emit('nact:peer:disconnect', { peerId: first.peer.id })
    assert.equal(app.nacp.getPendingCount(), 0, '离线时就释放旧心跳等待方')
    const second = await connectPeer(app, 'second', { accepting })
    if (accepting) await advance(50)
    assert.equal(second.heartbeats().length, 1, '新连接按本端角色发起新的探测')
    assert.notEqual(second.heartbeats()[0].id, oldRequest.id)
    assert.ok(second.sent.every(message => message.id !== oldRequest.id), '旧心跳不从 Backlog 补发')

    first.reply(oldRequest)
    await flush()
    await advance(100)
    assert.deepEqual(app.listConnectedApp(), ['them'])
    assert.equal(second.heartbeats().length, 2, '旧请求的异步回调不影响新连接继续探测')
  })
}

test('收到对端的心跳 Request 不会自行启动未注册连接的探测', async t => {
  const advance = clock(t)
  const app = await makeApp(t)
  const { peer, sent } = fakePeer(app)
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', peer.id)
  incomingHeartbeat(app, peer)
  await flush()
  await advance(200)
  assert.equal(sent.filter(isHeartbeat).length, 0)
  assert.ok(sent.some(message => message.type === 'response'), '仍正常应答收到的 Request')
})

test('旧连接的迟到 Response 不能满足新心跳的等待', async t => {
  const advance = clock(t)
  const app = await makeApp(t)
  const first = await connectPeer(app, 'first', { respond: false })
  app.bus.emit('nact:peer:disconnect', { peerId: first.peer.id })
  const second = await connectPeer(app, 'second', { respond: false })
  first.reply(first.heartbeats()[0])
  await flush()

  await advance(99)
  assert.deepEqual(app.listConnectedApp(), ['them'])
  await advance(1)
  assert.deepEqual(app.listConnectedApp(), [])
  assert.equal(second.heartbeats().length, 1)
  assert.equal(app.nacp.getPendingCount(), 0)
})

test('对端持续发心跳，不能推迟本端首次和后续探测', async t => {
  const advance = clock(t)
  const app = await makeApp(t)
  const remote = await connectPeer(app, 'peer', { accepting: true })
  assert.equal(remote.heartbeats().length, 0)

  for (let i = 1; i <= 15; i++) {
    await advance(10)
    incomingHeartbeat(app, remote.peer)
    await flush()
    if (i === 5) assert.equal(remote.heartbeats().length, 1, '注册后半周期发出第一条')
  }
  assert.ok(remote.heartbeats().length >= 2, '对端较快的发送节奏不能饿死本端探测')
})

test('等待 Response 时，对端 Request 和无关 Response 都不能推迟检查', async t => {
  const advance = clock(t)
  const app = await makeApp(t)
  const remote = await connectPeer(app, 'peer', { respond: false })
  await advance(80)
  incomingHeartbeat(app, remote.peer)
  remote.reply({ id: 'unrelated', meta: { kind: 'ability' } })
  await flush()

  await advance(19)
  assert.deepEqual(app.listConnectedApp(), ['them'])
  await advance(1)
  assert.deepEqual(app.listConnectedApp(), [])
  assert.equal(app.nacp.getPendingCount(), 0)
})

test('Response 到达后，下一次发送仍从上次发出时间计时', async t => {
  const advance = clock(t)
  const app = await makeApp(t)
  const remote = await connectPeer(app, 'peer', { respond: false })
  await advance(80)
  remote.reply(remote.heartbeats()[0])
  await flush()
  await advance(20)
  assert.equal(remote.heartbeats().length, 2)
  assert.deepEqual(app.listConnectedApp(), ['them'])
})

for (const ackTimeoutMs of [20, 200]) {
  test(`无 ACK：${ackTimeoutMs < 100 ? 'ACK 超时' : '下一心跳周期'}先触发离线`, async t => {
    const advance = clock(t)
    const app = await makeApp(t, { ackTimeoutMs })
    const remote = await connectPeer(app, 'peer', { ack: false, respond: false })
    const warnings = collect(app.bus, 'nacp:internal:ack:warning')
    const changes = collect(app.bus, 'nacp:internal:napp:success')
    const deadline = Math.min(100, ackTimeoutMs)

    await advance(deadline - 1)
    assert.deepEqual(app.listConnectedApp(), ['them'])
    await advance(1)
    assert.deepEqual(app.listConnectedApp(), [])
    assert.equal(app.nacp.getPendingCount(), 0)
    assert.deepEqual(warnings.events.map(({ payload }) => payload.msg.id),
      ackTimeoutMs < 100 ? [remote.heartbeats()[0].id] : [])
    await advance(200)
    assert.equal(changes.events.filter(({ payload }) => payload.reason === 'offline').length, 1)
    assert.equal(remote.heartbeats().length, 1, '离线后停止发送')
  })
}

test('收到完整 Response 即完成心跳，丢失的 ACK 不留下旧请求', async t => {
  const advance = clock(t)
  const app = await makeApp(t)
  const remote = await connectPeer(app, 'peer', { ack: false })
  const warnings = collect(app.bus, 'nacp:internal:ack:warning')
  await advance(20)
  assert.deepEqual(app.listConnectedApp(), ['them'])
  await advance(80)
  assert.equal(remote.heartbeats().length, 2)
  assert.equal(warnings.events.length, 0)
})

test('isOk=false 的 Response 也证明对端已应答', async t => {
  const advance = clock(t)
  const app = await makeApp(t)
  const remote = await connectPeer(app, 'peer', { respond: false })
  remote.reply(remote.heartbeats()[0], false)
  await flush()
  await advance(100)
  assert.deepEqual(app.listConnectedApp(), ['them'])
  assert.equal(remote.heartbeats().length, 2)
})

test('离线清理心跳后，宽限引用只取决于剩余业务等待方', async t => {
  // Real timers here: hasRef() determines whether the default 120s grace period keeps Node alive.
  const app = await makeApp(t, { heartbeatIntervalMs: 60_000, ackTimeoutMs: 10_000 })
  const remote = await connectPeer(app, 'peer', { respond: false })
  const business = app.request('them', { kind: 'ability', target: 'slow' })
  void business.response.catch(() => {})
  const businessRequest = remote.sent.find(message => message.id === business.reqId)
  await flush()

  app.bus.emit('nact:peer:disconnect', { peerId: remote.peer.id })
  assert.equal(app.nacp.getPendingCount(), 1, '只清理心跳，普通业务继续等待')
  const graceTimer = app.nacp.graceTimers.get('them')
  assert.equal(graceTimer.hasRef(), true)

  remote.reply(businessRequest)
  await business.response
  assert.equal(app.nacp.getPendingCount(), 0)
  assert.equal(graceTimer.hasRef(), false, '最后一个等待方结束后释放引用')

  const queued = app.request('them', { kind: 'ability', target: 'queued' })
  void queued.response.catch(() => {})
  assert.equal(graceTimer.hasRef(), true, '宽限期内新增业务等待方仍保持引用')
})

test('没有业务等待方时，断线清理心跳立即释放宽限定时器引用', async t => {
  const app = await makeApp(t, { heartbeatIntervalMs: 60_000, ackTimeoutMs: 10_000 })
  const remote = await connectPeer(app, 'peer', { respond: false })
  app.bus.emit('nact:peer:disconnect', { peerId: remote.peer.id })
  assert.equal(app.nacp.getPendingCount(), 0)
  assert.equal(app.nacp.graceTimers.get('them').hasRef(), false)
})
