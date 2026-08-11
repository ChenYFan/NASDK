/**
 * edge/nacp — 临界值与压力。
 *
 * full/nacp 覆盖协议正常路径，这里挑规模与退化：大量并发 pending、订阅表规模、
 * 断连时的批量清理、消息字段的退化形状、Gateway 转发的规模。
 *
 * 大部分测试用 fakePeer（不开 socket），因为要测的是 NACP 的表和状态机，不是网络。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NACPError } from '../../NACP/errors.ts'
import { NACTEvent } from '../../NACT/events.ts'
import {
  startApp, startPair, startBare, fakePeer, msg, registerMsg,
  tcp, unix, PORT, sleep, timed, collect,
} from '../_kit.mjs'

const SLOW = !!process.env.NASDK_SLOW

/** 一个绑好 fakePeer 的裸 App：peerId 已入 NACP 的 appId 表，可以直接收发。 */
async function bound(id = 'me', peerName = 'p1') {
  const app = await startBare(id)
  const { peer, sent } = fakePeer(app, peerName)
  app.nact.addPeer(peer)
  app.nacp.inbound(registerMsg({ from: 'them', to: id, id: 'reg-1' }), peer)
  await sleep(10)
  return { app, peer, sent }
}

// ── pending 表规模 ──

test('5000 条并发 request：每条回包各归各位，不串号', async () => {
  const spec = unix('edge-nacp-conc')
  const { cli, stop } = await startPair(spec)
  const N = 5000

  const [results, ms] = await timed(() => Promise.all(
    Array.from({ length: N }, (_, i) => cli.request('srv', { kind: 'ability', target: 'add', payload: { a: i, b: 0 } })),
  ))
  // 回值等于自己的入参 —— 这是「pending 表没把回包交错」的直接证据
  assert.deepEqual(results.map(r => r.payload), Array.from({ length: N }, (_, i) => i))
  assert.equal(cli.nacp.getPendingCount(), 0, '全部 settle，表清空')
  console.log(`    ${N} 条并发 request: ${ms.toFixed(0)}ms (${(N / (ms / 1000)).toFixed(0)} req/s)`)
  await stop()
})

test('5000 条 pending 挂着时断连：全部一次性 reject，表清空', async () => {
  const { app, peer } = await bound('cli-many')
  const N = 5000

  // fakePeer 不答 request（只答四种握手），所以这些会一直挂着
  const pendings = Array.from({ length: N }, (_, i) =>
    app.nacp.request('them', { kind: 'ability', target: 't', payload: { i } }).catch(e => e))
  await sleep(50)
  assert.equal(app.nacp.getPendingCount(), N, `${N} 条挂在表里`)

  const [errs, ms] = await timed(async () => {
    app.nact.dropPeer(peer.id)
    app.bus.emit(NACTEvent.peerDisconnect, { peerId: peer.id })
    return Promise.all(pendings)
  })

  assert.equal(errs.length, N)
  assert.ok(errs.every(e => e instanceof NACPError), '每条都是 NACPError')
  assert.ok(errs.every(e => e.code === 'peer-gone'), '理由都是 peer-gone')
  assert.equal(app.nacp.getPendingCount(), 0, '一条不留')
  console.log(`    ${N} 条 pending 批量 reject: ${ms.toFixed(0)}ms`)
  await app.terminate().catch(() => {})
})

test('terminate 时挂着的 pending 全部 reject 为 terminate', async () => {
  const { app, peer } = await bound('cli-term')
  const pendings = Array.from({ length: 500 }, () =>
    app.nacp.request('them', { kind: 'ability', target: 't', payload: {} }).catch(e => e))
  await sleep(30)

  app.nacp.terminate()
  const errs = await Promise.all(pendings)
  assert.ok(errs.every(e => e instanceof NACPError && e.code === 'terminate'),
    '理由是 terminate 而不是 peer-gone —— 两种收尾要能分辨')
  assert.equal(app.nacp.getPendingCount(), 0)
  assert.ok(peer)
})

test('request 到没有路由的 appId：立刻 reject not-sent，不进 pending 表', async () => {
  // REQUEST_TIMEOUT_MS = -1（业务调用不设超时），所以没有这条检查就会永远挂着。
  const app = await startBare('lonely')
  const [err, ms] = await timed(() => app.nacp.request('压根不存在', { kind: 'ability', target: 't' }).catch(e => e))
  assert.ok(err instanceof NACPError)
  assert.equal(err.code, 'not-sent')
  assert.equal(err.phase, 'outbound')
  assert.equal(app.nacp.getPendingCount(), 0, '没发出去的包不占 pending')
  assert.ok(ms < 500, `立刻失败而不是等超时，实测 ${ms.toFixed(1)}ms`)
  await app.terminate().catch(() => {})
})

test('1000 条 not-sent 连续失败，pending 表始终为 0', async () => {
  const app = await startBare('lonely2')
  const errs = await Promise.all(Array.from({ length: 1000 }, () =>
    app.nacp.request('nowhere', { kind: 'ability', target: 't' }).catch(e => e.code)))
  assert.ok(errs.every(c => c === 'not-sent'))
  assert.equal(app.nacp.getPendingCount(), 0, '一条也没漏进表')
  await app.terminate().catch(() => {})
})

// ── 订阅表规模 ──

test('2000 条订阅进来：全部入表，转发监听器都在', async () => {
  const { app, sent } = await bound('sub-host')
  const N = 2000

  const [, ms] = await timed(async () => {
    for (let i = 0; i < N; i++) {
      app.nacp.inbound(msg('subscribe', { from: 'them', to: 'sub-host', id: `s${i}`, payload: { targetSubName: `topic:${i}` } }), app.nact.getPeer('p1'))
    }
  })
  assert.equal(app.nacp.getSubCount(), N, `${N} 条订阅记录`)
  console.log(`    ${N} 条入站订阅: ${ms.toFixed(0)}ms`)

  // 每条订阅对应一个 bus listener：emit 一个 topic 只该发一条 notify
  const before = sent.length
  app.bus.emit('topic:500', { hit: true })
  await sleep(10)
  const notifies = sent.slice(before).filter(m => m.type === 'notify')
  assert.equal(notifies.length, 1, '一个 topic 只对应一条订阅，发一条 notify')
  assert.equal(notifies[0].meta.parentId, 's500', 'parentId 是那条订阅的 subId')

  await app.terminate().catch(() => {})
})

test('2000 条订阅在断连时一次性清空，bus 上不留监听器', async () => {
  const { app, peer, sent } = await bound('sub-clean')
  for (let i = 0; i < 2000; i++) {
    app.nacp.inbound(msg('subscribe', { from: 'them', to: 'sub-clean', id: `s${i}`, payload: { targetSubName: `t:${i}` } }), peer)
  }
  assert.equal(app.nacp.getSubCount(), 2000)

  const [, ms] = await timed(async () => {
    app.nact.dropPeer(peer.id)
    app.bus.emit(NACTEvent.peerDisconnect, { peerId: peer.id })
    await sleep(20)
  })
  assert.equal(app.nacp.getSubCount(), 0, '订阅表清空')

  // 关键：bus 上的转发监听器也得摘掉，否则 emit 还会试着往死 peer 发
  const before = sent.length
  for (let i = 0; i < 2000; i++) app.bus.emit(`t:${i}`, {})
  await sleep(20)
  assert.equal(sent.length, before, '断连后 emit 不再产生任何 notify —— 监听器真的摘干净了')
  console.log(`    2000 条订阅批量清理: ${ms.toFixed(0)}ms`)
  await app.terminate().catch(() => {})
})

test('同一个 targetSubName 被 500 个不同 subId 订阅：emit 一次发 500 条', async () => {
  const { app, sent } = await bound('multi-sub')
  app.bus.onError = () => {}                    // maxListeners 警告
  for (let i = 0; i < 500; i++) {
    app.nacp.inbound(msg('subscribe', { from: 'them', to: 'multi-sub', id: `dup${i}`, payload: { targetSubName: 'hot' } }), app.nact.getPeer('p1'))
  }
  const before = sent.length
  app.bus.emit('hot', { v: 1 })
  await sleep(20)
  const notifies = sent.slice(before).filter(m => m.type === 'notify')
  assert.equal(notifies.length, 500, '每条订阅各得一份 —— 订阅是按 subId 独立的')
  assert.equal(new Set(notifies.map(m => m.meta.parentId)).size, 500, '500 个不同 parentId')
  await app.terminate().catch(() => {})
})

test('通配符订阅：一条订阅命中多个 topic，hitSubName 各不相同', async () => {
  const { app, sent } = await bound('wild-sub')
  app.nacp.inbound(msg('subscribe', { from: 'them', to: 'wild-sub', id: 'w1', payload: { targetSubName: 'job:*' } }), app.nact.getPeer('p1'))

  const before = sent.length
  for (const k of ['job:start', 'job:tick', 'job:done']) app.bus.emit(k, { k })
  await sleep(20)
  const notifies = sent.slice(before).filter(m => m.type === 'notify')
  assert.equal(notifies.length, 3)
  assert.deepEqual(notifies.map(m => m.meta.hitSubName), ['job:start', 'job:tick', 'job:done'],
    'hitSubName 是本次真正命中的名字，不是订阅时的模式')
  assert.ok(notifies.every(m => m.meta.targetSubName === 'job:*'), 'targetSubName 保留原模式')
  await app.terminate().catch(() => {})
})

// ── listen 表规模（出站订阅侧）──

test('1000 条出站订阅，notify 按 parentId 各自派送', async () => {
  const { app, peer, sent } = await bound('listener')
  const got = new Map()
  const subs = []
  for (let i = 0; i < 1000; i++) {
    subs.push(app.nacp.subscribe('them', `remote:${i}`, (payload) => got.set(i, payload)))
  }
  await Promise.all(subs.map(p => p?.catch(() => {})))
  assert.equal(app.nacp.getListenCount(), 1000, '1000 条 listen 记录')

  // subId 就是那条 subscribe 消息自己的 id。fakePeer 把发出去的消息都记下来了，
  // 从中取回每条订阅的真实 subId，再按 parentId 反向喂 notify。
  const subMsgs = sent.filter(m => m.type === 'subscribe')
  assert.equal(subMsgs.length, 1000, '1000 条 subscribe 真的发出去了')

  for (const m of subMsgs) {
    const name = m.payload.targetSubName                 // 'remote:<i>'
    const i = Number(name.slice('remote:'.length))
    app.nacp.inbound(msg('notify', {
      from: 'them', to: 'listener',
      meta: { parentId: m.id, targetSubName: name, hitSubName: name },
      payload: { v: i },
    }), peer)
  }
  await sleep(20)

  assert.equal(got.size, 1000, '每条 notify 都命中了自己那条订阅的 targetListener')
  for (let i = 0; i < 1000; i++) assert.deepEqual(got.get(i), { v: i }, `第 ${i} 条没串到别人`)
  await app.terminate().catch(() => {})
})

// ── 消息字段退化 ──

test('payload 是各种退化值都能收发', async () => {
  const { app, sent } = await bound('degen')
  for (const payload of [undefined, null, 0, '', false, [], {}, { nested: { deep: null } }]) {
    const before = sent.length
    app.nacp.notify('them', { parentId: 'p', targetSubName: 't', hitSubName: 't', payload })
    assert.equal(sent.length, before + 1, `payload=${JSON.stringify(payload)} 也发得出`)
  }
  await app.terminate().catch(() => {})
})

test('超长 appId / targetSubName / target 都只是字符串', async () => {
  const { app, sent } = await bound('long')
  const long = 'x'.repeat(100 * 1024)
  app.nacp.notify('them', { parentId: 'p', targetSubName: long, hitSubName: long, payload: {} })
  const last = sent[sent.length - 1]
  assert.equal(last.meta.targetSubName.length, long.length, '10 万字符的订阅名照样带着走')
  await app.terminate().catch(() => {})
})

test('入站消息缺字段 / 字段类型不对：不崩，落到相应的错误通道', async () => {
  // 用 bound()：them 已绑到 p1，所以回给 them 的 response 能真正路由出去、进 sent。
  // （fakePeer 的 sent 只记它自己 send 的；response 到未注册的 from 会路由失败、不进任何 peer。）
  const { app, peer, sent } = await bound('robust')
  const errs = collect(app.bus, 'nacp:internal:*:error')

  // 这些都是协议上不该出现的形状 —— 关键是「不崩」，而不是具体怎么报
  const bad = [
    msg('notify', { from: 'them', to: 'robust', meta: {} }),                          // 没有 parentId
    msg('response', { from: 'them', to: 'robust', meta: { parentId: '不存在' } }),      // 无主回包
    msg('unsubscribe', { from: 'them', to: 'robust', payload: { targetSubId: '无' } }), // 无主退订
    msg('subscribe', { from: 'them', to: 'robust', id: 'bad-sub', payload: {} }),       // 没有 targetSubName
  ]
  for (const m of bad) assert.doesNotThrow(() => app.nacp.inbound(m, peer), `type=${m.type}`)
  await sleep(20)
  errs.stop()
  assert.ok(errs.events.length >= 2, `至少几条进了错误通道，实得 ${errs.events.length}`)

  // 缺 targetSubName 的 subscribe：曾经会让 bus.listen(undefined) 抛 TypeError、冒到 inbound 外把连接拆掉。
  // 现在应当只是被拒：既进 subscribeError，又回一条 isOk:false 的 response，连接照旧。
  const subErr = errs.events.find(e => e.payload.reason === 'bad-target-sub-name')
  assert.ok(subErr, 'subscribe 缺 targetSubName 落到 bad-target-sub-name')
  const reject = sent.find(m => m.type === 'response' && m.meta.parentId === 'bad-sub')
  assert.ok(reject, '给出了回应答而不是让对端干等 10s')
  assert.equal(reject.meta.isOk, false)
  assert.equal(reject.meta.whyNotOk, 'bad-target-sub-name')

  await app.terminate().catch(() => {})
})

test('未知 type 的入站消息被忽略而不是崩', async () => {
  const app = await startBare('unknown-type')
  const { peer } = fakePeer(app, 'p-u')
  app.nact.addPeer(peer)
  assert.doesNotThrow(() => app.nacp.inbound(msg('压根没这个type', { from: 'x', to: 'unknown-type' }), peer))
  await app.terminate().catch(() => {})
})

// ── 并发连接 + Gateway ──

test('50 个 App 同时注册到一个 Gateway，路由表全对', async () => {
  const spec = tcp(PORT.edgeB)
  const { app: gw, stop: stopGw } = await startApp('gw', { server: [spec], opt: { isGateway: true } })

  const N = 50
  const [clients, ms] = await timed(async () => {
    const made = []
    for (let i = 0; i < N; i++) {
      const { app, stop } = await startApp(`peer${i}`)
      await app.connect('gw', spec)
      made.push({ app, stop })
    }
    return made
  })
  await sleep(200)

  assert.equal(gw.nacp.listAppId().length, N, `Gateway 认识 ${N} 个 App`)
  for (let i = 0; i < N; i++) assert.ok(gw.nacp.checkAppId(`peer${i}`), `peer${i} 在表里`)
  console.log(`    ${N} 个 App 注册到 Gateway: ${ms.toFixed(0)}ms`)

  // 经 Gateway 互打：peer0 → peer49
  const [res, fwdMs] = await timed(() => clients[0].app.request('peer49', { kind: 'ability', target: 'add', payload: { a: 20, b: 22 } }))
  assert.equal(res.payload, 42, '经 Gateway 转发打通')
  console.log(`    经 Gateway 的一次往返: ${fwdMs.toFixed(1)}ms`)

  for (const c of clients) await c.stop()
  await sleep(200)
  assert.equal(gw.nacp.listAppId().length, 0, '全部离表')
  await stopGw()
})

test('Gateway 转发 500 条并发，全部到位', async () => {
  const spec = tcp(PORT.edgeB + 1)
  const { app: gw, stop: stopGw } = await startApp('gw2', { server: [spec], opt: { isGateway: true } })
  const { app: a, stop: stopA } = await startApp('aa')
  const { app: b, stop: stopB } = await startApp('bb')
  await a.connect('gw2', spec)
  await b.connect('gw2', spec)
  await sleep(100)

  const N = 500
  const [results, ms] = await timed(() => Promise.all(
    Array.from({ length: N }, (_, i) => a.request('bb', { kind: 'ability', target: 'add', payload: { a: i, b: 0 } })),
  ))
  assert.deepEqual(results.map(r => r.payload), Array.from({ length: N }, (_, i) => i), '每条都是自己的回包')
  console.log(`    ${N} 条经 Gateway 转发: ${ms.toFixed(0)}ms (${(N / (ms / 1000)).toFixed(0)} req/s)`)

  await stopA(); await stopB(); await stopGw()
})

// ── AutoSub 规模 ──

test('500 条并发 event request，AutoSub 表在终结后全部回收', async () => {
  const spec = unix('edge-nacp-autosub')
  const { cli, stop } = await startPair(spec)

  const N = 500
  const chunks = new Map()
  const [results, ms] = await timed(() => Promise.all(
    Array.from({ length: N }, (_, i) => cli.request('srv', {
      kind: 'event', target: 'run', payload: { task: 'emit', n: 2 },
      onProcess: (c) => { chunks.set(i, (chunks.get(i) ?? 0) + 1) },
    })),
  ))

  assert.equal(results.length, N)
  assert.equal(cli.nacp.getListenCount(), 0, 'AutoSub 的本地半条在 request 终结时全部回收')
  assert.equal(cli.nacp.getPendingCount(), 0, 'pending 也清空')
  console.log(`    ${N} 条并发 event request（带过程流）: ${ms.toFixed(0)}ms`)
  await stop()
})

// ── 超时路径（默认 skip）──

test('subscribe 无人应答：10s 后 reject timeout', { skip: !SLOW }, async () => {
  // RESPONSE_TIMEOUT_MS = 10s（握手类必须快）。answer:false 让 fakePeer 只记录不答。
  const app = await startBare('silent')
  const { peer } = fakePeer(app, 'p-silent', { answer: false })
  app.nact.addPeer(peer)
  app.nacp.inbound(registerMsg({ from: 'them', to: 'silent' }), peer)
  await sleep(10)

  const [err, ms] = await timed(() => app.nacp.subscribe('them', 'topic', () => {})?.catch(e => e))
  assert.ok(err instanceof NACPError)
  assert.equal(err.code, 'timeout')
  console.log(`    subscribe 超时于 ${(ms / 1000).toFixed(1)}s`)
  await app.terminate().catch(() => {})
})

test('request 永不超时 —— REQUEST_TIMEOUT_MS = -1 是刻意的', async () => {
  // 业务调用多久算超时，框架无从知道。这条钉住「有路由但对端不答 → 一直等」。
  const app = await startBare('patient')
  const { peer } = fakePeer(app, 'p-quiet', { answer: false })
  app.nact.addPeer(peer)
  app.nacp.inbound(registerMsg({ from: 'them', to: 'patient' }), peer)
  await sleep(10)

  const race = await Promise.race([
    app.nacp.request('them', { kind: 'ability', target: 't' }).catch(e => `REJECTED:${e.code}`),
    sleep(300).then(() => 'STILL-WAITING'),
  ])
  assert.equal(race, 'STILL-WAITING', 'request 不设超时，挂着就是挂着')
  assert.equal(app.nacp.getPendingCount(), 1, '还在表里等')
  await app.terminate().catch(() => {})
})
