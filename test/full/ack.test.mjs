/**
 * full/ack — NACP ACK 生命周期与断线续发。
 *
 * 使用 fake peer 精确控制 ACK 到达时机；Gateway 的真实多跳往返由 edge/nacp 覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildMessage } from '../../NACP/types.ts'
import { startBare, fakePeer, msg, registerMsg, collect, sleep } from '../_kit.mjs'

async function bound(id = 'me', opt = {}, answer = false) {
  const app = await startBare(id, opt)
  const { peer, sent } = fakePeer(app, 'p1', { answer })
  app.nact.addPeer(peer)
  app.nacp.bindAppId('them', peer.id)
  return { app, peer, sent }
}

async function terminateSilent(app) {
  app.nacp.terminate()
  await app.nact.terminate()
}

async function waitFor(promise, timeoutMs = 200) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('ACK 信封只携带 parentId，不携带 payload', () => {
  const ack = buildMessage('receiver', 'ack', 'sender', { parentId: 'message-1' })
  assert.equal(ack.type, 'ack')
  assert.equal(ack.meta.parentId, 'message-1')
  assert.equal('payload' in ack, false)
})

test('公开 ack() 发送 ACK 且不等待对端 ACK', async () => {
  const { app, sent } = await bound()
  assert.equal(await app.nacp.ack('them', { parentId: 'message-1' }), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'ack')
  assert.equal(sent[0].meta.parentId, 'message-1')
  assert.equal('payload' in sent[0], false)
  await terminateSilent(app)
})

test('response 在对应 ACK 到达前保持 pending，到达后完成', async () => {
  const { app, peer, sent } = await bound()
  const delivered = app.response('them', { parentId: 'request-1', isOk: true })
  const response = sent.find(m => m.type === 'response')

  assert.equal(await Promise.race([delivered, sleep(20).then(() => 'pending')]), 'pending')
  app.nacp.inbound(msg('ack', {
    from: 'them', to: 'me', meta: { parentId: response.id }, payload: undefined,
  }), peer)
  assert.equal(await delivered, true)
  await terminateSilent(app)
})

test('可靠入站消息先回 ACK；重复消息只再 ACK，不重复投递', async () => {
  const { app, peer, sent } = await bound()
  const errors = collect(app.bus, 'nacp:internal:response:error')
  const response = msg('response', {
    from: 'them', to: 'me', id: 'same-response',
    meta: { parentId: 'missing-request', isOk: true },
  })

  app.nacp.inbound(response, peer)
  app.nacp.inbound(response, peer)
  errors.stop()

  assert.equal(sent.filter(m => m.type === 'ack' && m.meta.parentId === response.id).length, 2)
  assert.deepEqual(errors.events.map(e => e.payload.reason), ['has-no-consumer'])
  await terminateSilent(app)
})

test('ACK 自身不被 ACK，未知 ACK 只进入错误通道', async () => {
  const { app, peer, sent } = await bound()
  const errors = collect(app.bus, 'nacp:internal:ack:error')

  app.nacp.inbound(msg('ack', {
    from: 'them', to: 'me', meta: { parentId: 'unknown-message' }, payload: undefined,
  }), peer)
  errors.stop()

  assert.equal(sent.filter(m => m.type === 'ack').length, 0)
  assert.deepEqual(errors.events.map(e => e.payload.reason), ['has-no-consumer'])
  await terminateSilent(app)
})

test('ACK 超时进入 offline；重连先完成握手，再按原顺序续发 backlog', async () => {
  const { app, sent } = await bound('me', { ackTimeoutMs: 20, reconnectGraceMs: 500 })
  const responseDone = app.response('them', { parentId: 'request-1', isOk: true })
  const firstResponse = sent.find(m => m.type === 'response')

  await sleep(40)
  assert.deepEqual(app.listConnectedApp(), [])
  assert.deepEqual(app.listConnectedApp({ isOnlineOnly: false }), ['them'])
  assert.equal(await Promise.race([responseDone, sleep(10).then(() => 'pending')]), 'pending')

  const notifyDone = app.notify('them', {
    parentId: 'subscription-1', targetSubName: 'job:*', hitSubName: 'job:tick', payload: { n: 1 },
  })
  assert.equal(await Promise.race([notifyDone, sleep(10).then(() => 'pending')]), 'pending')

  const { peer: returning, sent: replayed } = fakePeer(app, 'p2', { answer: true })
  app.nact.addPeer(returning)
  app.nacp.inbound(registerMsg({ from: 'them', to: 'me', id: 'return-register' }), returning)

  assert.equal(await responseDone, true)
  assert.equal(await notifyDone, true)
  const types = replayed.map(m => m.type)
  assert.deepEqual(types.slice(0, 2), ['ack', 'response'], '重连握手先完成')
  assert.ok(replayed.some(m => m.type === 'response' && m.id === firstResponse.id), '原 response 保持 id 重发')
  assert.ok(replayed.some(m => m.type === 'notify'), '离线期间的 notify 随后发出')
  await app.terminate()
})

test('重连宽限到期后丢弃 backlog，并以 false 结束 ACK waiter', async () => {
  const { app } = await bound('me', { ackTimeoutMs: 15, reconnectGraceMs: 25 })
  const delivered = app.response('them', { parentId: 'request-1', isOk: true })

  assert.equal(await waitFor(delivered), false)
  assert.deepEqual(app.listConnectedApp({ isOnlineOnly: false }), [])
  await app.terminate()
})

test('Gateway 透明转发端到端 ACK，不在中继节点消费或代答', async () => {
  const gw = await startBare('gw', { isGateway: true })
  const { peer: pa, sent: sa } = fakePeer(gw, 'pa', { answer: false })
  const { peer: pb } = fakePeer(gw, 'pb', { answer: false })
  gw.nact.addPeer(pa); gw.nact.addPeer(pb)
  gw.nacp.bindAppId('A', 'pa'); gw.nacp.bindAppId('B', 'pb')
  const errors = collect(gw.bus, 'nacp:internal:ack:error')
  const ack = msg('ack', { from: 'B', to: 'A', meta: { parentId: 'response-1' }, payload: undefined })

  gw.nacp.inbound(ack, pb)
  errors.stop()

  assert.equal(sa.length, 1)
  assert.equal(sa[0], ack, 'Gateway 不改写端到端 ACK')
  assert.equal(errors.events.length, 0, 'Gateway 不消费这条 ACK')
  await terminateSilent(gw)
})
