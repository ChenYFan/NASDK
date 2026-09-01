/**
 * full/nacp — 覆盖协议层正常会走到的路径。
 *
 * 不起 socket：假 Peer 塞进 peer 表，出站消息就落到手里；inbound 直接喂造好的消息。这样才能覆盖到
 * 一个配合的对端永远不会发出来的东西（跨大版本、未知订阅、错地址）。
 * 真网络下的联测在 full/napp。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROTOCOL_V } from '../../NACP/types.ts'
import { NACPError } from '../../NACP/errors.ts'
import { startBare, fakePeer, msg, registerMsg, collect, sleep } from '../_kit.mjs'

/** 一个已经和 'them' 绑好的 App，最常用的起点。 */
async function bound(id = 'me', { answer = true, opt } = {}) {
  const app = await startBare(id, opt)
  const { peer, sent } = fakePeer(app, 'p1', { answer })
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')
  return { app, peer, sent, stop: () => app.terminate() }
}

// ── 信封构造 ──

test('出站消息都能构造，v/id/t/from 一律齐全', async () => {
  const { app, sent, stop } = await bound()

  app.nacp.notify('them', { parentId: 'p', targetSubName: 'a', hitSubName: 'a' })
  app.nacp.response('them', { parentId: 'p', isOk: true })
  app.nacp.subscribe('them', 'x:*', () => {})
  app.nacp.unsubscribe('them', 'sub-1')
  app.nacp.unregister('them').catch(() => {})
  app.nacp.request('them', { kind: 'ability', target: 't' }).catch(() => {})

  const byType = Object.fromEntries(sent.map(m => [m.type, m]))
  for (const [type, m] of Object.entries(byType)) {
    assert.deepEqual(m.v, PROTOCOL_V, `${type}: 带协议版本`)
    assert.equal(typeof m.id, 'string', `${type}: 有 id`)
    assert.equal(typeof m.t, 'number', `${type}: 有时间戳`)
    assert.equal(m.from, 'me', `${type}: from 是自己`)
    assert.ok('meta' in m && 'payload' in m, `${type}: meta 和 payload 都在`)
  }
  assert.deepEqual(
    Object.keys(byType).sort(),
    ['notify', 'request', 'response', 'subscribe', 'unregister', 'unsubscribe'],
  )
  await stop()
})

test('可选字段不写就不上线 —— 不是 present-and-undefined', async () => {
  const { app, sent, stop } = await bound()

  app.nacp.response('them', { parentId: 'p', isOk: true })          // 不给 whyNotOk / kind
  const ok = sent.find(m => m.type === 'response')
  assert.ok(!('whyNotOk' in ok.meta), 'CBOR 会把显式 undefined 编成真 key，所以必须整个不写')
  assert.ok(!('kind' in ok.meta))

  sent.length = 0
  app.nacp.response('them', { parentId: 'p', isOk: false, whyNotOk: '原因', kind: 'event' })
  const bad = sent.find(m => m.type === 'response')
  assert.equal(bad.meta.whyNotOk, '原因')
  assert.equal(bad.meta.kind, 'event')
  await stop()
})

test('四个内部族的信息在 payload，meta 是空的', async () => {
  const { app, sent, stop } = await bound()
  app.nacp.subscribe('them', 'name:*', () => {})
  app.nacp.unsubscribe('them', 'sub-9')
  app.nacp.unregister('them').catch(() => {})

  const sub = sent.find(m => m.type === 'subscribe')
  assert.deepEqual(sub.meta, {}, 'subscribe 的 meta 是空的')
  assert.equal(sub.payload.targetSubName, 'name:*', '要说的话在 payload')

  const unsub = sent.find(m => m.type === 'unsubscribe')
  assert.deepEqual(unsub.meta, {})
  assert.equal(unsub.payload.targetSubId, 'sub-9')

  const unreg = sent.find(m => m.type === 'unregister')
  assert.deepEqual(unreg.meta, {})
  assert.deepEqual(unreg.payload, {}, '「我要走了」信封的 from 已经说完了')
  await stop()
})

// ── 出站路由 ──

test('出站三种失败各有 reason，都返 false', async () => {
  const app = await startBare('me')
  const errs = collect(app.bus, 'nacp:internal:route:error')

  assert.equal(await app.nacp.notify('陌生人', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), false)
  assert.equal(await app.nacp.notify('me', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), false)

  // send-failed：appId 绑到一个不在 peer 表里的 peerId
  app.nacp.bindAppId('ghost', 'peer-不存在')
  assert.equal(await app.nacp.notify('ghost', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), false)
  // 解绑：否则 terminate 会给这个不存在的 peer 发 unregister，白等满 10s 超时
  app.nacp.dropAppId('ghost')

  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['no-route', 'self-addressed', 'send-failed'])
  await app.terminate()
})

test('出站事件先发、再做副作用 —— 失败的尝试也可观测', async () => {
  const app = await startBare('me')
  const out = collect(app.bus, 'nacp:outbound:notify')
  app.nacp.notify('没人', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' })
  out.stop()
  assert.equal(out.events.length, 1, '发不出去也发了 outbound 事件')
  assert.equal(out.events[0].payload.toPeerId, undefined)
  await app.terminate()
})

test('notify 等出站，response 等 ACK', async () => {
  const { app, stop } = await bound()
  assert.equal(await app.nacp.notify('them', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), true)
  assert.equal(await app.nacp.response('them', { parentId: 'x', isOk: true }), true)
  assert.equal(await app.nacp.notify('没人', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), false)
  await stop()
})

// ── register ──

test('register 成功：建表 + 对称应答（带自己的 decl 和 isGateway）', async () => {
  const app = await startBare('me')
  const { peer, sent } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  const ok = collect(app.bus, 'nacp:internal:napp:success')

  app.nacp.inbound(registerMsg({ from: 'other', to: 'me', id: 'r1' }), peer)

  assert.equal(app.nacp.checkAppId('other'), true)
  assert.equal(app.nacp.getAppPeerId('other'), 'p1')
  ok.stop()
  assert.deepEqual(ok.events.map(e => e.payload.reason), ['bound'])

  const receipt = sent.find(m => m.type === 'ack')
  assert.equal(receipt.meta.parentId, 'r1', 'register 通过入站 peer 直接 ACK')
  assert.ok(!('payload' in receipt), 'ACK 信封没有 payload')
  const response = sent.find(m => m.type === 'response')
  assert.equal(response.meta.isOk, true)
  assert.equal(response.meta.parentId, 'r1')
  assert.equal(typeof response.payload.isGateway, 'boolean')
  assert.ok(Array.isArray(response.payload.decl.events), '一个往返换完能力声明')
  assert.ok(Array.isArray(response.payload.decl.abilities))
  await app.terminate()
})

test('register 拒绝的四种原因', async (t) => {
  await t.test('version-mismatch：大版本不同', async () => {
    const app = await startBare('me')
    const { peer, sent } = fakePeer(app, 'p1')
    app.nact.addPeer(peer)
    const errs = collect(app.bus, 'nacp:internal:register:error')

    app.nacp.inbound(registerMsg({ from: 'o', to: 'me', v: { major: 99, minor: 0 } }), peer)

    errs.stop()
    assert.deepEqual(errs.events.map(e => e.payload.reason), ['version-mismatch'])
    assert.equal(app.nacp.checkAppId('o'), false, '没建表')
    assert.equal(sent.find(m => m.type === 'response').meta.whyNotOk, 'version-mismatch')
    await app.terminate()
  })

  await t.test('小版本不同是兼容的', async () => {
    const app = await startBare('me')
    const { peer } = fakePeer(app, 'p1')
    app.nact.addPeer(peer)
    app.nacp.inbound(registerMsg({ from: 'o', to: 'me', v: { major: PROTOCOL_V.major, minor: 999 } }), peer)
    assert.equal(app.nacp.checkAppId('o'), true, '同 major 就兼容')
    await app.terminate()
  })

  await t.test('appId-in-use：同名再来，拒新留旧', async () => {
    const app = await startBare('me')
    const { peer: p1 } = fakePeer(app, 'p1')
    const { peer: p2, sent: s2 } = fakePeer(app, 'p2')
    app.nact.addPeer(p1); app.nact.addPeer(p2)
    const errs = collect(app.bus, 'nacp:internal:register:error')

    app.nacp.inbound(registerMsg({ from: 'dup', to: 'me' }), p1)
    app.nacp.inbound(registerMsg({ from: 'dup', to: 'me' }), p2)

    errs.stop()
    assert.deepEqual(errs.events.map(e => e.payload.reason), ['appId-in-use'])
    assert.equal(app.nacp.getAppPeerId('dup'), 'p1', '留的是先到的那条')
    assert.equal(s2.find(m => m.type === 'response').meta.isOk, false)
    await app.terminate()
  })

  await t.test('dual-gateway：两个 Gateway 撞上', async () => {
    const app = await startBare('gw', { isGateway: true })
    const { peer } = fakePeer(app, 'p1')
    app.nact.addPeer(peer)
    const errs = collect(app.bus, 'nacp:internal:register:error')

    app.nacp.inbound(registerMsg({ from: 'other-gw', to: 'gw', payload: { isGateway: true } }), peer)

    errs.stop()
    assert.deepEqual(errs.events.map(e => e.payload.reason), ['dual-gateway'])
    assert.equal(app.nacp.checkAppId('other-gw'), false)
    await app.terminate()
  })
})

test('register：to 不是自己就丢弃，连话都不回', async () => {
  const app = await startBare('me')
  const { peer, sent } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  const gwErrs = collect(app.bus, 'nacp:internal:gateway:error')

  app.nacp.inbound(registerMsg({ from: 'o', to: '别人' }), peer)

  gwErrs.stop()
  assert.equal(sent.length, 0, '不回话 —— 对端靠自己的 10s 超时发现「你拨错了」')
  assert.deepEqual(gwErrs.events.map(e => e.payload.reason), ['dropped'])
  assert.equal(app.nacp.checkAppId('o'), false)
  await app.terminate()
})

// ── Gateway 槽位 ──

test('Gateway 槽位先到先得', async () => {
  const app = await startBare('me')
  const { peer: p1 } = fakePeer(app, 'p1')
  app.nact.addPeer(p1)
  assert.equal(app.nacp.getGatewayPeerId(), undefined, '一开始没有')

  app.nacp.inbound(registerMsg({ from: 'gw1', to: 'me', payload: { isGateway: true } }), p1)
  assert.equal(app.nacp.getGatewayPeerId(), 'p1', '第一个声明的拿到槽位')
  await app.terminate()
})

test('第二个 Gateway：autoMultiGatewayDowngrade=true 时降级保留', async () => {
  const app = await startBare('me', { autoMultiGatewayDowngrade: true })
  const { peer: p1 } = fakePeer(app, 'p1')
  const { peer: p2 } = fakePeer(app, 'p2')
  app.nact.addPeer(p1); app.nact.addPeer(p2)
  const warns = collect(app.bus, 'nacp:internal:gateway:warning')

  app.nacp.inbound(registerMsg({ from: 'gw1', to: 'me', payload: { isGateway: true } }), p1)
  app.nacp.inbound(registerMsg({ from: 'gw2', to: 'me', payload: { isGateway: true } }), p2)

  warns.stop()
  assert.equal(app.nacp.getGatewayPeerId(), 'p1', '槽位还是第一个的')
  assert.equal(app.nacp.checkAppId('gw2'), true, '链路保留，只是不作兜底')
  assert.deepEqual(warns.events.map(w => w.payload.reason), ['multi-gateway-downgraded'])
  await app.terminate()
})

test('第二个 Gateway：默认(false)时视为组网错误，拒连', async () => {
  const app = await startBare('me')      // autoMultiGatewayDowngrade 默认 false
  const { peer: p1 } = fakePeer(app, 'p1')
  const { peer: p2 } = fakePeer(app, 'p2')
  app.nact.addPeer(p1); app.nact.addPeer(p2)
  const errs = collect(app.bus, 'nacp:internal:register:error')

  app.nacp.inbound(registerMsg({ from: 'gw1', to: 'me', payload: { isGateway: true } }), p1)
  app.nacp.inbound(registerMsg({ from: 'gw2', to: 'me', payload: { isGateway: true } }), p2)

  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['multi-gateway'])
  assert.equal(app.nacp.checkAppId('gw2'), false, 'bind 被回滚')
  assert.equal(app.nacp.getGatewayPeerId(), 'p1')
  await app.terminate()
})

test('普通 App 不动 Gateway 槽位', async () => {
  const app = await startBare('me')
  const { peer } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  app.nacp.inbound(registerMsg({ from: 'plain', to: 'me' }), peer)
  assert.equal(app.nacp.getGatewayPeerId(), undefined)
  await app.terminate()
})

// ── Gateway 转发 ──

test('isGateway=true：to≠self 且认识目标 → 转发，且 from/to 不改写', async () => {
  const app = await startBare('gw', { isGateway: true })
  const { peer: pa } = fakePeer(app, 'pa')
  const { peer: pb, sent: sb } = fakePeer(app, 'pb')
  app.nact.addPeer(pa); app.nact.addPeer(pb)
  app.nacp.bindAppId('A', 'pa')
  app.nacp.bindAppId('B', 'pb')
  const fwd = collect(app.bus, 'nacp:internal:gateway:success')

  const m = msg('request', { from: 'A', to: 'B', meta: { kind: 'ability', target: 't' }, payload: { v: 1 } })
  app.nacp.inbound(m, pa)

  fwd.stop()
  assert.deepEqual(fwd.events.map(f => f.payload.reason), ['forwarded'])
  const relayed = sb.find(x => x.type === 'request')
  assert.equal(relayed.from, 'A', '端到端字段，逐跳不改写')
  assert.equal(relayed.to, 'B')
  assert.deepEqual(relayed.payload, { v: 1 })
  await app.terminate()
})

test('isGateway=true 但不认识目标 → 丢弃', async () => {
  const app = await startBare('gw', { isGateway: true })
  const { peer, sent } = fakePeer(app, 'pa')
  app.nact.addPeer(peer)
  app.nacp.bindAppId('A', 'pa')
  const errs = collect(app.bus, 'nacp:internal:gateway:error')

  app.nacp.inbound(msg('notify', { from: 'A', to: '不认识的C', meta: { parentId: 'x', targetSubName: 'a', hitSubName: 'a' } }), peer)

  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['dropped'])
  assert.equal(sent.length, 0)
  await app.terminate()
})

test('isGateway=false：to≠self 一律丢弃，不管认不认识', async () => {
  const app = await startBare('plain')
  const { peer: pa } = fakePeer(app, 'pa')
  const { peer: pb, sent: sb } = fakePeer(app, 'pb')
  app.nact.addPeer(pa); app.nact.addPeer(pb)
  app.nacp.bindAppId('A', 'pa'); app.nacp.bindAppId('B', 'pb')
  const errs = collect(app.bus, 'nacp:internal:gateway:error')

  app.nacp.inbound(msg('request', { from: 'A', to: 'B', meta: { kind: 'ability', target: 't' } }), pa)

  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['dropped'])
  assert.equal(sb.length, 0, '普通 App 不转发')
  await app.terminate()
})

test('inbound 事件无条件先发 —— 连要被丢弃的包也算「逻辑上进来了」', async () => {
  const app = await startBare('plain')
  const { peer } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  const inb = collect(app.bus, 'nacp:inbound:notify')

  app.nacp.inbound(msg('notify', { from: 'A', to: '别人', meta: { parentId: 'x', targetSubName: 'a', hitSubName: 'a' } }), peer)

  inb.stop()
  assert.equal(inb.events.length, 1)
  assert.equal(inb.events[0].payload.fromPeerId, 'p1')
  await app.terminate()
})

test('没有路由时出站兜底走 Gateway', async () => {
  const app = await startBare('me')
  const { peer: pg, sent: sg } = fakePeer(app, 'pg')
  app.nact.addPeer(pg)
  app.nacp.inbound(registerMsg({ from: 'gw', to: 'me', payload: { isGateway: true } }), pg)
  sg.length = 0

  // 'unknown' 没绑过，应该落到 Gateway 那条链路上
  assert.equal(await app.nacp.notify('unknown', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), true)
  assert.equal(sg.find(m => m.type === 'notify')?.to, 'unknown', '包原样交给 Gateway，to 不变')
  await app.terminate()
})

// ── unregister / 断连 ──

test('unregister 进来：先回话再清理（清理会拆掉回话用的路由）', async () => {
  const { app, peer, sent, stop } = await bound()
  // subscribe 返回的 Promise 在清理时会 reject（订阅随对端一起没了），必须接住
  const subAck = app.nacp.subscribe('them', 'x:*', () => {})?.catch(() => {})
  app.nacp.inbound(msg('subscribe', { from: 'them', to: 'me', id: 's1', payload: { targetSubName: 'mine:*' } }), peer)
  sent.length = 0

  app.nacp.inbound(msg('unregister', { from: 'them', to: 'me', id: 'u1' }), peer)

  const ack = sent.find(m => m.type === 'response')
  assert.ok(ack, '回了 ack')
  assert.equal(ack.meta.parentId, 'u1')
  assert.equal(app.nacp.checkAppId('them'), false, '之后才解绑')
  await stop()
  await subAck
})

test('意外断连进入宽限期，协议状态与等待方保留', async () => {
  const { app, peer, stop } = await bound()

  const subAck = app.nacp.subscribe('them', 'x:*', () => {})?.catch(e => e)       // ListenTable
  app.nacp.inbound(msg('subscribe', { from: 'them', to: 'me', id: 's1', payload: { targetSubName: 'mine:*' } }), peer)  // SubscribeTable
  const pending = app.nacp.request('them', { kind: 'ability', target: 't' }).catch(e => e)  // PendingTable
  assert.equal(app.nacp.getListenCount(), 1)
  assert.equal(app.nacp.getSubCount(), 1)
  // pending 表装的是「所有在等应答的出站消息」，不只是 request —— 这里 subscribe 和 request 各占一条。
  // （假 Peer 会应答 subscribe，但那是下一个微任务，此刻还没到。）
  assert.equal(app.nacp.getPendingCount(), 2)

  app.bus.emit('nact:peer:disconnect', { peerId: 'p1' })   // 物理断连

  assert.equal(app.nacp.checkAppId('them'), true, '宽限期内仍记得这个 appId')
  assert.deepEqual(app.nacp.listOnlineAppId(), [], '但不再报告为在线')
  assert.equal(app.nacp.getListenCount(), 1)
  assert.equal(app.nacp.getSubCount(), 1)
  assert.equal(app.nacp.getPendingCount(), 2, '等待方留到重连或宽限到期')
  await stop()
  assert.ok((await pending) instanceof Error)
  await subAck
})

test('断连宽限期保留对端订阅，过程通知进入 backlog', async () => {
  const { app, peer, sent, stop } = await bound()
  app.nacp.inbound(msg('subscribe', { from: 'them', to: 'me', id: 's1', payload: { targetSubName: 'mine:*' } }), peer)

  app.bus.emit('nact:peer:disconnect', { peerId: 'p1' })

  const before = sent.length
  app.bus.emit('mine:hello', { v: 1 })
  assert.equal(app.nacp.getSubCount(), 1, '订阅留待重连恢复')
  assert.equal(sent.length, before, '离线时不碰已经断开的物理链路')
  await stop()
})

// ── subscribe / notify ──

test('subscribe 建 ListenTable，出站前就建好（同步可见）', async () => {
  const { app, stop } = await bound()
  assert.equal(app.nacp.getListenCount(), 0)
  app.nacp.subscribe('them', 'x:*', () => {})
  assert.equal(app.nacp.getListenCount(), 1, '不用等对端应答')
  await stop()
})

test('subscribe 的 opt.subId 可以覆盖 key（AutoSub 用它对齐 reqId）', async () => {
  const { app, stop } = await bound()
  let handed
  app.nacp.subscribe('them', 'x:*', () => {}, { subId: '我指定的id', onSubId: (id) => { handed = id } })
  assert.equal(handed, '我指定的id', 'onSubId 在出站前同步递出')
  await stop()
})

test('request 的 onReqId 在返回前同步递出消息 id', async () => {
  const { app, sent, stop } = await bound()
  let reqId
  const response = app.nacp.request('them', {
    kind: 'ability', target: 't', onReqId: (id) => { reqId = id },
  }).catch(() => {})
  assert.equal(reqId, sent.find(m => m.type === 'request').id)
  await stop()
  await response
})

test('subscribe 的 autoSub：只建本地半条，不出站', async () => {
  const { app, sent, stop } = await bound()
  const ret = app.nacp.subscribe('them', 'x:*', () => {}, { subId: 'r1', autoSub: true })
  assert.equal(ret, undefined, 'autoSub 不返回 Promise')
  assert.equal(app.nacp.getListenCount(), 1, '本地半条建了')
  assert.equal(sent.length, 0, '没有 subscribe 帧上线')
  await stop()
})

test('notify 进来：命中 ListenTable 就调回调，且不回复 ACK', async () => {
  const { app, peer, sent, stop } = await bound()
  const got = []
  app.nacp.subscribe('them', 'x:*', (payload, m) => got.push({ payload, hit: m.meta.hitSubName }),
    { subId: 'sub-1' })

  app.nacp.inbound(msg('notify', {
    from: 'them', to: 'me',
    meta: { parentId: 'sub-1', targetSubName: 'x:*', hitSubName: 'x:concrete' },
    payload: { v: 42 },
  }), peer)

  assert.deepEqual(got, [{ payload: { v: 42 }, hit: 'x:concrete' }])
  assert.equal(sent.some(m => m.type === 'ack'), false)
  await stop()
})

test('notify 找不到订阅 → has-no-consumer', async () => {
  const { app, peer, stop } = await bound()
  const errs = collect(app.bus, 'nacp:internal:notify:error')

  app.nacp.inbound(msg('notify', {
    from: 'them', to: 'me',
    meta: { parentId: '没有这个订阅', targetSubName: 'x', hitSubName: 'x' },
  }), peer)

  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['has-no-consumer'])
  await stop()
})

test('对端订阅我：emit → notify，parentId 是那条 subscribe 的 id', async () => {
  const { app, peer, sent, stop } = await bound()
  app.nacp.inbound(msg('subscribe', { from: 'them', to: 'me', id: 'sub-9', payload: { targetSubName: 'mine:*' } }), peer)
  sent.length = 0

  app.bus.emit('mine:hello', { v: 1 })

  const n = sent.find(m => m.type === 'notify')
  assert.equal(n.meta.parentId, 'sub-9')
  assert.equal(n.meta.targetSubName, 'mine:*', '订的模式')
  assert.equal(n.meta.hitSubName, 'mine:hello', '命中的具体名')
  await stop()
})

test('unsubscribe 进来：摘监听器 + 回 ack；未知订阅报错但也回话', async () => {
  const { app, peer, sent, stop } = await bound()
  app.nacp.inbound(msg('subscribe', { from: 'them', to: 'me', id: 'sub-9', payload: { targetSubName: 'mine:*' } }), peer)
  assert.equal(app.nacp.getSubCount(), 1)
  sent.length = 0

  app.nacp.inbound(msg('unsubscribe', { from: 'them', to: 'me', id: 'u1', payload: { targetSubId: 'sub-9' } }), peer)
  assert.equal(app.nacp.getSubCount(), 0)
  assert.equal(sent.find(m => m.type === 'response').meta.isOk, true)

  sent.length = 0
  const errs = collect(app.bus, 'nacp:internal:subscribe:error')
  app.nacp.inbound(msg('unsubscribe', { from: 'them', to: 'me', id: 'u2', payload: { targetSubId: '不存在' } }), peer)
  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['unknown-subscription'])
  const nack = sent.find(m => m.type === 'response')
  assert.equal(nack.meta.isOk, false)
  assert.equal(nack.meta.whyNotOk, 'unknown-subscription')
  await stop()
})

test('本地 unsubscribe 先删 ListenTable 再出站', async () => {
  const { app, stop } = await bound()
  app.nacp.subscribe('them', 'x:*', () => {}, { subId: 'sub-1' })
  assert.equal(app.nacp.getListenCount(), 1)
  app.nacp.unsubscribe('them', 'sub-1')?.catch(() => {})
  assert.equal(app.nacp.getListenCount(), 0)
  await stop()
})

// ── request / response ──

test('没有 Processor 的 kind → 立刻拒，报 no-processor', async () => {
  const app = await startBare('me')       // startBare 不绑 kit 的 processor，但 start() 会兜默认的
  const { peer, sent } = fakePeer(app, 'p1')
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  // 默认 NACEB/NACAB 已被 start() 兜上，所以这里问一个不存在的 target 而不是不存在的 kind
  app.nacp.inbound(msg('request', {
    from: 'them', to: 'me', id: 'req-1', meta: { kind: 'ability', target: '没这个能力' },
  }), peer)
  await sleep(30)

  const res = sent.find(m => m.type === 'response')
  assert.equal(res.meta.isOk, false)
  assert.equal(res.meta.parentId, 'req-1')
  assert.equal(res.meta.kind, 'ability', 'response 回显 kind')
  await app.terminate()
})

test('response 进来：settle 对应的 pending', async () => {
  const { app, peer, sent, stop } = await bound()
  const p = app.nacp.request('them', { kind: 'ability', target: 't' })
  const req = sent.find(m => m.type === 'request')
  assert.equal(app.nacp.getPendingCount(), 1)

  app.nacp.inbound(msg('response', {
    from: 'them', to: 'me', meta: { parentId: req.id, isOk: true, kind: 'ability' }, payload: { r: 7 },
  }), peer)

  const res = await p
  assert.deepEqual(res.payload, { r: 7 })
  assert.equal(app.nacp.getPendingCount(), 0)
  await stop()
})

test('isOk=false 的 response 让 request reject，code 是 response-not-ok', async () => {
  const { app, peer, sent, stop } = await bound()
  const p = app.nacp.request('them', { kind: 'ability', target: 't' })
  const req = sent.find(m => m.type === 'request')

  app.nacp.inbound(msg('response', {
    from: 'them', to: 'me', meta: { parentId: req.id, isOk: false, whyNotOk: '业务失败' },
  }), peer)

  await assert.rejects(p, (e) => {
    assert.ok(e instanceof NACPError)
    assert.equal(e.code, 'response-not-ok')
    assert.equal(e.message, '业务失败', 'whyNotOk 成了 message')
    return true
  })
  await stop()
})

test('无主 response → has-no-consumer', async () => {
  const { app, peer, stop } = await bound()
  const errs = collect(app.bus, 'nacp:internal:response:error')
  app.nacp.inbound(msg('response', { from: 'them', to: 'me', meta: { parentId: '没人等这个', isOk: true } }), peer)
  errs.stop()
  assert.deepEqual(errs.events.map(e => e.payload.reason), ['has-no-consumer'])
  await stop()
})

// ── AutoSub ──

test('event 请求自动建本地订阅，subId 就是 reqId', async () => {
  const { app, peer, sent, stop } = await bound()
  assert.equal(app.nacp.getListenCount(), 0)

  const p = app.nacp.request('them', { kind: 'event', target: 'e', onProcess: () => {} }).catch(() => {})
  const req = sent.find(m => m.type === 'request')

  assert.equal(app.nacp.getListenCount(), 1, 'AutoSub 的本地半条')
  assert.equal(sent.filter(m => m.type === 'subscribe').length, 0, '不发真 subscribe')

  // 过程流的 parentId 就是 reqId —— 这是两侧唯一共知的 id
  const got = []
  app.nacp.inbound(msg('notify', {
    from: 'them', to: 'me',
    meta: { parentId: req.id, targetSubName: `nacp:event:${req.id}:process`, hitSubName: `nacp:event:${req.id}:process` },
    payload: { chunk: 1 },
  }), peer)

  await stop()
  await p
})

test('ability 请求不建订阅 —— 能力没有过程流', async () => {
  const { app, stop } = await bound()
  const p = app.nacp.request('them', { kind: 'ability', target: 'a', onProcess: () => {} }).catch(() => {})
  assert.equal(app.nacp.getListenCount(), 0)
  await stop()
  await p
})

test('event 请求即使不给 onProcess 也建订阅 —— 对端只看 kind', async () => {
  const { app, stop } = await bound()
  const p = app.nacp.request('them', { kind: 'event', target: 'e' }).catch(() => {})
  assert.equal(app.nacp.getListenCount(), 1, '否则对端会往一个没建的订阅上发 notify')
  await stop()
  await p
})

test('event 的 response 到达时自动撤掉 AutoSub', async () => {
  const { app, peer, sent, stop } = await bound()
  const p = app.nacp.request('them', { kind: 'event', target: 'e', onProcess: () => {} })
  const req = sent.find(m => m.type === 'request')
  assert.equal(app.nacp.getListenCount(), 1)

  app.nacp.inbound(msg('response', {
    from: 'them', to: 'me', meta: { parentId: req.id, isOk: true, kind: 'event' }, payload: {},
  }), peer)

  await p
  assert.equal(app.nacp.getListenCount(), 0, '终结即回收，不用发 unsubscribe')
  await stop()
})

// ── terminate ──

test('terminate 清空四张表并失败所有等待者', async () => {
  const { app, peer, stop } = await bound()
  const subAck = app.nacp.subscribe('them', 'x:*', () => {})?.catch(() => {})
  app.nacp.inbound(msg('subscribe', { from: 'them', to: 'me', id: 's1', payload: { targetSubName: 'mine:*' } }), peer)
  const pending = app.nacp.request('them', { kind: 'ability', target: 't' }).catch(e => e)

  app.nacp.terminate()

  assert.deepEqual(app.nacp.listAppId(), [])
  assert.equal(app.nacp.getListenCount(), 0)
  assert.equal(app.nacp.getSubCount(), 0)
  assert.equal(app.nacp.getPendingCount(), 0)
  assert.ok((await pending) instanceof Error)
  await subAck
  await stop()
})
