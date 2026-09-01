/**
 * simple/nacp — 协议层自己的机制：造一条消息、看信封长什么样、喂进 inbound 看表怎么变。
 *
 * NACP 平时被 NApp 门面包着，用户不直接调。这个文件不起网络：假 Peer 塞进 peer 表，出站消息就落到
 * 手里；inbound 直接喂造好的消息。看的是「协议层怎么运转」，不是「怎么用 NASDK」（那是 napp）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import NApp from '../../index.ts'

/** 一个只记录、自动 ACK 可靠消息并应答握手族的假 Peer。 */
function fakePeer(app, id = 'p1') {
  const sent = []
  const peer = {
    id,
    send(msg) {
      sent.push(msg)
      if (msg.type !== 'notify' && msg.type !== 'ack') {
        queueMicrotask(() => app.nacp.inbound({
          v: msg.v, type: 'ack', id: `ack-${msg.id}`, from: msg.to, to: msg.from, t: Date.now(),
          meta: { parentId: msg.id },
        }, peer))
      }
      if (['register', 'unregister', 'subscribe', 'unsubscribe'].includes(msg.type)) {
        queueMicrotask(() => app.nacp.inbound({
          v: msg.v, type: 'response', id: `response-${msg.id}`, from: msg.to, to: msg.from, t: Date.now(),
          meta: { parentId: msg.id, isOk: true }, payload: {},
        }, peer))
      }
    },
    close() {},
  }
  return { peer, sent }
}

test('信封：每条消息都带 v/type/id/from/to/t + meta + payload', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const { peer, sent } = fakePeer(app)
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  app.nacp.notify('them', { parentId: 'req-1', targetSubName: 'job:*', hitSubName: 'job:done', payload: { x: 1 } })

  const m = sent[0]
  assert.equal(m.type, 'notify')
  assert.deepEqual(m.v, { major: 2, minor: 1 })       // 协议版本，同 major 兼容
  assert.equal(m.from, 'me')                           // 端到端，不逐跳改写
  assert.equal(m.to, 'them')
  assert.equal(typeof m.id, 'string')
  assert.equal(typeof m.t, 'number')
  // notify 的 meta 带两个名字：订的那个（可能有通配符）和实际命中的那个
  assert.equal(m.meta.targetSubName, 'job:*')
  assert.equal(m.meta.hitSubName, 'job:done')
  assert.deepEqual(m.payload, { x: 1 })

  await app.terminate()
})

test('request 的 meta 带 kind 和 target', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const { peer, sent } = fakePeer(app)
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  // request 的 promise 要等一条真 response 才 settle；假 Peer 不答 request，所以 terminate 会让它 reject。
  // 必须接住，否则测试结束后冒出 unhandledRejection。
  const pending = app.nacp.request('them', { kind: 'ability', target: 'math.add', payload: { a: 1 } })
    .catch(() => { /* terminate 时失败，预期行为 */ })

  const m = sent.find(x => x.type === 'request')
  assert.equal(m.meta.kind, 'ability')
  assert.equal(m.meta.target, 'math.add')

  await app.terminate()
  await pending
})

test('register 进来：建 appId 表 + 回一条 isOk response', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const { peer, sent } = fakePeer(app)
  app.nact.addPeer(peer)

  assert.equal(app.nacp.checkAppId('other'), false)

  app.nacp.inbound({
    v: { major: 2, minor: 1 }, type: 'register', id: 'r1', from: 'other', to: 'me', t: Date.now(),
    meta: {}, payload: { isGateway: false, decl: { events: [], abilities: [] } },
  }, peer)

  assert.equal(app.nacp.checkAppId('other'), true, 'appId 绑上了')
  assert.deepEqual(app.nacp.listAppId(), ['other'])
  const ack = sent.find(m => m.type === 'response')
  assert.equal(ack.meta.isOk, true)
  assert.equal(ack.meta.parentId, 'r1', 'response 用 parentId 指回它答的那条')
  // register 的应答是对称的：把自己的 isGateway + decl 一并回过去，一个往返换完能力
  assert.equal(typeof ack.payload.isGateway, 'boolean')
  assert.ok(ack.payload.decl)

  await app.terminate()
})

test('to 不是自己的 register 直接丢弃，不回话', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const { peer, sent } = fakePeer(app)
  app.nact.addPeer(peer)

  app.nacp.inbound({
    v: { major: 2, minor: 1 }, type: 'register', id: 'r2', from: 'other', to: '别人', t: Date.now(),
    meta: {}, payload: { isGateway: false, decl: { events: [], abilities: [] } },
  }, peer)

  assert.equal(app.nacp.checkAppId('other'), false)
  assert.equal(sent.length, 0, '不属于自己的包，静默丢弃')

  await app.terminate()
})

test('unregister 进来：解绑', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const { peer } = fakePeer(app)
  app.nact.addPeer(peer)
  app.nacp.bindAppId('other', 'p1')
  assert.equal(app.nacp.checkAppId('other'), true)

  app.nacp.inbound({
    v: { major: 2, minor: 1 }, type: 'unregister', id: 'u1', from: 'other', to: 'me', t: Date.now(),
    meta: {}, payload: {},
  }, peer)

  assert.equal(app.nacp.checkAppId('other'), false, '解绑了')
  await app.terminate()
})

test('没有路由时出站返 false，并报 route:error', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const errs = []
  app.bus.listen('nacp:internal:route:error', (p) => errs.push(p.reason))

  // 没 bindAppId，也没有 Gateway 兜底
  const ok = await app.nacp.notify('陌生人', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' })
  assert.equal(ok, false)
  assert.deepEqual(errs, ['no-route'])

  await app.terminate()
})

test('发给自己也返 false —— 没有线可以走', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const errs = []
  app.bus.listen('nacp:internal:route:error', (p) => errs.push(p.reason))

  const ok = await app.nacp.notify('me', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' })
  assert.equal(ok, false)
  assert.deepEqual(errs, ['self-addressed'])

  await app.terminate()
})

test('四张表可数：订阅/监听/在途请求', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const { peer } = fakePeer(app)
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  assert.equal(app.nacp.getSubCount(), 0)
  assert.equal(app.nacp.getListenCount(), 0)
  assert.equal(app.nacp.getPendingCount(), 0)

  // 本地订阅一条：ListenTable +1（出站前就建，所以同步可见）
  app.nacp.subscribe('them', 'job:*', () => {})
  assert.equal(app.nacp.getListenCount(), 1)

  // 对端订阅我：SubscribeTable +1
  app.nacp.inbound({
    v: { major: 2, minor: 1 }, type: 'subscribe', id: 's1', from: 'them', to: 'me', t: Date.now(),
    meta: {}, payload: { targetSubName: 'mine:*' },
  }, peer)
  assert.equal(app.nacp.getSubCount(), 1)

  await app.terminate()
  assert.equal(app.nacp.getSubCount(), 0, 'terminate 清空所有表')
  assert.equal(app.nacp.getListenCount(), 0)
})

test('对端订阅我之后，我 bus 上的 emit 会被转成 notify 发回去', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const { peer, sent } = fakePeer(app)
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', 'p1')

  app.nacp.inbound({
    v: { major: 2, minor: 1 }, type: 'subscribe', id: 'sub-9', from: 'them', to: 'me', t: Date.now(),
    meta: {}, payload: { targetSubName: 'mine:*' },
  }, peer)

  sent.length = 0
  app.bus.emit('mine:hello', { v: 1 })      // 这就是「远程 EventBus 订阅」的全部机制

  const n = sent.find(m => m.type === 'notify')
  assert.ok(n, '产生了一条 notify')
  assert.equal(n.to, 'them')
  assert.equal(n.meta.parentId, 'sub-9', 'notify 的 parentId 就是那条 subscribe 的 id')
  assert.deepEqual(n.payload, { v: 1 })

  // 两个名字都在：订的是通配符，命中的是具体事件。
  // 本地监听器靠 EventBus 回调的第二个参数拿到具体名字，跨进程时它会丢，所以写进 meta。
  assert.equal(n.meta.targetSubName, 'mine:*', '订阅的模式')
  assert.equal(n.meta.hitSubName, 'mine:hello', '实际命中的具体名字')

  sent.length = 0
  app.bus.emit('mine:world', { v: 2 })
  assert.equal(sent.find(m => m.type === 'notify').meta.hitSubName, 'mine:world')

  await app.terminate()
})
