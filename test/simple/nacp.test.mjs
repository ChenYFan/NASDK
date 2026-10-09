// NACP internals exercised without network: a fake peer feeds crafted inbound messages.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import NApp from '../../index.ts'

/** Fake peer: records sent messages, auto-ACKs reliable ones, answers handshake family. */
function fakePeer(app, id = 'p1') {
  const sent = []
  const peer = {
    id,
    async send(msg) {
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
  assert.deepEqual(m.v, { major: 2, minor: 1 })       // same-major versions are compatible
  assert.equal(m.from, 'me')                           // end-to-end, not rewritten per hop
  assert.equal(m.to, 'them')
  assert.equal(typeof m.id, 'string')
  assert.equal(typeof m.t, 'number')
  // notify meta carries both the subscribed pattern and the actually hit name
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

  // fake peer never answers request; terminate rejects it. Catch to avoid unhandledRejection.
  const pending = app.nacp.request('them', { kind: 'ability', target: 'math.add', payload: { a: 1 } })
    .catch(() => { /* expected on terminate */ })

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
  // register response is symmetric: isGateway + decl go back, one round trip exchanges capabilities
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
  const dropped = app.bus.asyncListenOnce('nacp:internal:napp:success')

  app.nacp.inbound({
    v: { major: 2, minor: 1 }, type: 'unregister', id: 'u1', from: 'other', to: 'me', t: Date.now(),
    meta: {}, payload: {},
  }, peer)

  await dropped
  assert.equal(app.nacp.checkAppId('other'), false, '解绑了')
  await app.terminate()
})

test('没有路由时出站返 false，并报 route:error', async () => {
  const app = new NApp({ id: 'me' })
  await app.start()
  const errs = []
  app.bus.listen('nacp:internal:route:error', (p) => errs.push(p.reason))

  // no bindAppId and no gateway fallback
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

  // local subscribe: ListenTable +1, visible synchronously before the outbound message
  app.nacp.subscribe('them', 'job:*', () => {})
  assert.equal(app.nacp.getListenCount(), 1)

  // peer subscribes to us: SubscribeTable +1
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
  app.bus.emit('mine:hello', { v: 1 })      // this is the whole "remote EventBus subscribe" mechanism

  const n = sent.find(m => m.type === 'notify')
  assert.ok(n, '产生了一条 notify')
  assert.equal(n.to, 'them')
  assert.equal(n.meta.parentId, 'sub-9', 'notify 的 parentId 就是那条 subscribe 的 id')
  assert.deepEqual(n.payload, { v: 1 })

  // the hit name is lost across IPC otherwise, so it travels in meta
  assert.equal(n.meta.targetSubName, 'mine:*', '订阅的模式')
  assert.equal(n.meta.hitSubName, 'mine:hello', '实际命中的具体名字')

  sent.length = 0
  app.bus.emit('mine:world', { v: 2 })
  assert.equal(sent.find(m => m.type === 'notify').meta.hitSubName, 'mine:world')

  await app.terminate()
})
