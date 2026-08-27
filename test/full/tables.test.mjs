/**
 * full/tables — NACP 状态四表的单测（OutboundBacklog / AckPending / InboundReceived / PeerAppConnection）。
 *
 * 不起 socket、不碰 NApp/NACP 实例：表是纯数据结构，手工造记录直接断言。
 * cap 用小数字，让溢出算术一眼可读。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OutboundBacklogTable, AckPendingTable, InboundReceivedTable, PeerAppConnectionTable, measureBytes,
} from '../../NACP/tables.ts'

/** 一条 OutboundRecord。bytes 显式给数 —— cap 测试要的是可读的算术，不是真实测量。 */
let seq = 0
const rec = (type, destAppId, bytes) => ({
  msg: {
    v: { major: 1, minor: 0 }, type, id: `m-${++seq}`, from: 'me', to: destAppId,
    t: Date.now(), meta: {}, payload: {},
  },
  destAppId, bytes, sentOnce: false,
})

// ── OutboundBacklogTable：三级溢出策略 ──

test('插入序被保留，也就是驱逐序 —— listByAppId 按入队顺序返回', () => {
  const t = new OutboundBacklogTable(10000, 10)
  const a = rec('request', 'a', 100)
  const b = rec('request', 'a', 100)
  const c = rec('request', 'b', 100)
  t.add(a); t.add(b); t.add(c)
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [a.msg.id, b.msg.id])
})

test('未触顶时 add 返回空数组 —— 正常路径没有牺牲品', () => {
  const t = new OutboundBacklogTable(1000, 3)
  assert.deepEqual(t.add(rec('request', 'a', 300)), [])
  assert.deepEqual(t.add(rec('notify', 'a', 300)), [])
  assert.equal(t.size(), 2)
  assert.equal(t.bytes(), 600)
})

test('tier 1：触顶时到来的 notify 自己被丢弃，队列原封不动', () => {
  const t = new OutboundBacklogTable(1000, 3)
  const a = rec('request', 'a', 300)
  const b = rec('request', 'a', 300)
  const c = rec('request', 'a', 300)
  t.add(a); t.add(b); t.add(c)
  const n = rec('notify', 'a', 10)
  // 第 4 条触发 count cap；排队的 notify 已经等过了，比刚到的更接近发出
  const out = t.add(n)
  assert.deepEqual(out, [{ rec: n, reason: 'notify-dropped' }])
  assert.equal(t.has(n.msg.id), false)
  assert.equal(t.size(), 3)
  assert.equal(t.bytes(), 900)
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [a.msg.id, b.msg.id, c.msg.id])
})

test('tier 2：非 notify 触顶时先驱逐最老的 notify，新来者存活', () => {
  const t = new OutboundBacklogTable(1000, 10)
  const n1 = rec('notify', 'a', 300)
  const n2 = rec('notify', 'a', 300)
  const n3 = rec('notify', 'a', 300)
  t.add(n1); t.add(n2); t.add(n3)
  const r = rec('request', 'a', 300)
  const out = t.add(r) // 1200 > 1000 → 驱逐 n1 后 900，cap 收住
  assert.deepEqual(out, [{ rec: n1, reason: 'notify-evicted' }])
  assert.equal(t.has(r.msg.id), true)
  assert.equal(t.has(n1.msg.id), false)
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [n2.msg.id, n3.msg.id, r.msg.id])
})

test('tier 3：队列里没有 notify 可花时，退化为纯 FIFO 驱逐最老记录', () => {
  const t = new OutboundBacklogTable(1000, 10)
  const a = rec('request', 'a', 400)
  const b = rec('response', 'a', 400)
  t.add(a); t.add(b)
  const c = rec('request', 'a', 400)
  const out = t.add(c) // 1200 > 1000 → 驱逐 a 后 800
  assert.deepEqual(out, [{ rec: a, reason: 'fifo-evicted' }])
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [b.msg.id, c.msg.id])
})

test('notify 先于可靠消息被花掉 —— 哪怕可靠消息更老', () => {
  const t = new OutboundBacklogTable(1000, 10)
  const oldReliable = rec('request', 'a', 200) // 最老，但不是 notify
  const n1 = rec('notify', 'a', 300)
  const n2 = rec('notify', 'a', 300)
  t.add(oldReliable); t.add(n1); t.add(n2) // 800
  const big = rec('request', 'a', 600)
  const out = t.add(big) // 1400 → 两个 notify 都花掉后 800；oldReliable 虽最老仍存活
  assert.deepEqual(out, [
    { rec: n1, reason: 'notify-evicted' },
    { rec: n2, reason: 'notify-evicted' },
  ])
  assert.equal(t.has(oldReliable.msg.id), true)
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [oldReliable.msg.id, big.msg.id])
})

test('单条超过 maxBytes 的消息仍被收留 —— 腾空所有人后独占队列', () => {
  const t = new OutboundBacklogTable(1000, 10)
  const a = rec('request', 'a', 400)
  const b = rec('notify', 'a', 400)
  t.add(a); t.add(b)
  const huge = rec('request', 'a', 1500)
  const out = t.add(huge)
  // 队列必须装得下一条最大尺寸的消息；拒绝它等于静默丢弃最不能丢的东西
  assert.deepEqual(out, [
    { rec: b, reason: 'notify-evicted' },
    { rec: a, reason: 'fifo-evicted' },
  ])
  assert.equal(t.size(), 1)
  assert.equal(t.bytes(), 1500)
  assert.equal(t.has(huge.msg.id), true)
})

test('unshiftAll 把记录插到队头，保持给定顺序', () => {
  const t = new OutboundBacklogTable(10000, 100)
  const x1 = rec('request', 'a', 100)
  const x2 = rec('request', 'a', 100)
  t.add(x1); t.add(x2)
  const r1 = rec('request', 'a', 100)
  const r2 = rec('request', 'a', 100)
  t.unshiftAll([r1, r2])
  // 断线时 awaiting-ack 的记录先于还在排队的重发，维持它们原本的线上顺序
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [r1.msg.id, r2.msg.id, x1.msg.id, x2.msg.id])
  assert.equal(t.bytes(), 400)
})

test('unshiftAll([]) 是 no-op', () => {
  const t = new OutboundBacklogTable(10000, 100)
  const a = rec('request', 'a', 100)
  const b = rec('request', 'a', 100)
  t.add(a); t.add(b)
  t.unshiftAll([])
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [a.msg.id, b.msg.id])
  assert.equal(t.size(), 2)
  assert.equal(t.bytes(), 200)
})

test('drainByAppId / deleteByAppId 取走并删除该 appId 的记录，按插入序，账目同步', () => {
  const t = new OutboundBacklogTable(10000, 100)
  const a1 = rec('request', 'a', 100)
  const b1 = rec('request', 'b', 200)
  const a2 = rec('request', 'a', 300)
  t.add(a1); t.add(b1); t.add(a2)
  const out = t.drainByAppId('a')
  assert.deepEqual(out, [a1, a2])
  assert.equal(t.size(), 1)
  assert.equal(t.bytes(), 200)
  assert.equal(t.has(a1.msg.id), false)
  // drain 与 discard 是同一个操作，差别只在调用方接下来做什么
  assert.deepEqual(t.deleteByAppId('b'), [b1])
  assert.equal(t.size(), 0)
  assert.equal(t.bytes(), 0)
})

test('多个 appId 共存一张表，drain 一个不惊动其它', () => {
  const t = new OutboundBacklogTable(10000, 100)
  const a1 = rec('request', 'a', 100)
  const b1 = rec('request', 'b', 100)
  const b2 = rec('request', 'b', 100)
  t.add(a1); t.add(b1); t.add(b2)
  t.drainByAppId('a')
  assert.deepEqual(t.listByAppId('b').map(x => x.msg.id), [b1.msg.id, b2.msg.id])
  assert.equal(t.bytes(), 200)
})

// ── AckPendingTable ──

test('settle 返回记录并移除；第二次 settle 返回 undefined', () => {
  const t = new AckPendingTable(10000, 100)
  const r = rec('request', 'a', 100)
  t.add(r)
  assert.equal(t.settle(r.msg.id), r)
  assert.equal(t.settle(r.msg.id), undefined)
  assert.equal(t.size(), 0)
})

test('溢出是纯 FIFO —— notify 分层在这里不适用', () => {
  const t = new AckPendingTable(1000, 10)
  const a = rec('request', 'a', 400)
  const b = rec('response', 'a', 400)
  t.add(a); t.add(b)
  const c = rec('request', 'a', 400)
  assert.deepEqual(t.add(c), [a]) // byte cap：1200 > 1000 → 驱逐 a
  assert.deepEqual(t.listByAppId('a').map(x => x.msg.id), [b.msg.id, c.msg.id])

  const t2 = new AckPendingTable(100000, 2)
  const x = rec('request', 'a', 10)
  const y = rec('request', 'a', 10)
  t2.add(x); t2.add(y)
  assert.deepEqual(t2.add(rec('request', 'a', 10)), [x]) // count cap 同样纯 FIFO
})

test('drainByAppId 置 sentOnce —— 区分「从未发出」和「发过但未被确认」', () => {
  const t = new AckPendingTable(10000, 100)
  const a1 = rec('request', 'a', 100)
  const b1 = rec('request', 'b', 100)
  t.add(a1); t.add(b1)
  assert.deepEqual(t.drainByAppId('a'), [a1])
  assert.equal(a1.sentOnce, true)
  assert.equal(b1.sentOnce, false) // 别的 appId 的记录不受牵连
})

test('bytes/size 在 add/settle/drain 全程对账，清空后归零', () => {
  const t = new AckPendingTable(10000, 100)
  const a = rec('request', 'a', 100)
  const b = rec('request', 'a', 200)
  t.add(a); t.add(b)
  assert.equal(t.bytes(), 300)
  assert.equal(t.size(), 2)
  t.settle(a.msg.id)
  assert.equal(t.bytes(), 200)
  assert.equal(t.size(), 1)
  t.drainByAppId('a')
  assert.equal(t.bytes(), 0)
  assert.equal(t.size(), 0)
})

// ── InboundReceivedTable ──

test('add 之后 has 为真；未知 id 为假', () => {
  const t = new InboundReceivedTable(10)
  t.add('m1', 'a')
  assert.equal(t.has('m1'), true)
  assert.equal(t.has('m-unknown'), false)
})

test('count cap 从最老开始驱逐，刚加入的 id 总能存活', () => {
  const t = new InboundReceivedTable(3)
  t.add('m1', 'a'); t.add('m2', 'a'); t.add('m3', 'a')
  t.add('m4', 'a')
  assert.equal(t.size(), 3)
  assert.equal(t.has('m1'), false)
  assert.equal(t.has('m4'), true)
})

test('deleteByAppId 只删该 appId 的 id', () => {
  const t = new InboundReceivedTable(10)
  t.add('a1', 'a'); t.add('b1', 'b'); t.add('a2', 'a')
  t.deleteByAppId('a')
  assert.equal(t.has('a1'), false)
  assert.equal(t.has('a2'), false)
  assert.equal(t.has('b1'), true)
})

test('clear 清空', () => {
  const t = new InboundReceivedTable(10)
  t.add('m1', 'a'); t.add('m2', 'b')
  t.clear()
  assert.equal(t.size(), 0)
  assert.equal(t.has('m1'), false)
  assert.equal(t.has('m2'), false)
})

// ── PeerAppConnectionTable ──

test('bind 后 online，可反查 peerId', () => {
  const t = new PeerAppConnectionTable()
  t.bind('a', 'p1')
  assert.equal(t.getState('a'), 'online')
  assert.equal(t.isOnline('a'), true)
  assert.equal(t.getPeerIdbyAppId('a'), 'p1')
})

test('markOffline 的快照记录断线那一刻的 Gateway 现场', () => {
  const t = new PeerAppConnectionTable()
  t.bind('gw', 'p1')
  t.setGateway('p1', 'gw')
  t.bind('a', 'p1')
  const snap = t.markOffline('a')
  assert.deepEqual(snap, { peerId: 'p1', gatewayPeerId: 'p1', gatewayAppId: 'gw' })
  assert.equal(t.getState('a'), 'offline')
  // 之后 Gateway 槽位被清，快照不动 —— 宽限期到点时要读的是断线当时的现场
  t.deleteAppIdbyAppId('gw')
  assert.deepEqual(t.getSnapshot('a'), { peerId: 'p1', gatewayPeerId: 'p1', gatewayAppId: 'gw' })
})

test('对已 offline 的 App 再 markOffline 返回 undefined，不覆盖第一份快照', () => {
  const t = new PeerAppConnectionTable()
  t.bind('gw', 'p1')
  t.setGateway('p1', 'gw')
  t.bind('a', 'p1')
  const first = t.markOffline('a')
  t.deleteAppIdbyAppId('gw') // 现场已变
  assert.equal(t.markOffline('a'), undefined)
  assert.deepEqual(t.getSnapshot('a'), first) // 第一份才是真的
})

test('对未知 appId markOffline 返回 undefined', () => {
  const t = new PeerAppConnectionTable()
  assert.equal(t.markOffline('nobody'), undefined)
})

test('重新 bind 让 offline 的 App 回到 online，快照随之清除', () => {
  const t = new PeerAppConnectionTable()
  t.bind('a', 'p1')
  t.markOffline('a')
  t.bind('a', 'p2')
  assert.equal(t.isOnline('a'), true)
  assert.equal(t.getSnapshot('a'), undefined)
  assert.equal(t.getPeerIdbyAppId('a'), 'p2')
})

test('一个 peerId 可挂多个 appId —— list/deleteByPeerId 返回全部而非只有第一个', () => {
  const t = new PeerAppConnectionTable()
  t.bind('a1', 'p9'); t.bind('a2', 'p9'); t.bind('a3', 'p9')
  t.bind('other', 'p1')
  assert.deepEqual(t.listAppIdbyPeerId('p9'), ['a1', 'a2', 'a3'])
  const removed = t.deleteAppIdbyPeerId('p9')
  assert.deepEqual(removed, ['a1', 'a2', 'a3'])
  assert.equal(t.has('a1'), false)
  assert.equal(t.has('a3'), false)
  assert.equal(t.has('other'), true)
})

test('Gateway 槽位先到先得：第二个不同 peer 抢不走，同 peer 重报幂等', () => {
  const t = new PeerAppConnectionTable()
  assert.equal(t.setGateway('p1', 'gw'), true)
  assert.equal(t.setGateway('p2', 'other'), false)
  assert.equal(t.getGatewayPeerId(), 'p1')
  assert.equal(t.getGatewayAppId(), 'gw')
  assert.equal(t.setGateway('p1', 'gw'), true) // 重连重报
})

test('getGatewayAppId 返回持槽的 appId', () => {
  const t = new PeerAppConnectionTable()
  assert.equal(t.getGatewayAppId(), undefined)
  t.setGateway('p1', 'gw')
  assert.equal(t.getGatewayAppId(), 'gw')
})

test('deleteAppIdbyAppId 只在删的是持槽者时才清 Gateway —— 共享 peerId 的中继 App 带不走中继', () => {
  const t = new PeerAppConnectionTable()
  t.bind('gw', 'p1')
  t.setGateway('p1', 'gw')
  t.bind('relayed', 'p1') // 经 Gateway 抵达的 App，与 gw 同 peerId
  t.deleteAppIdbyAppId('relayed')
  assert.equal(t.getGatewayPeerId(), 'p1')
  assert.equal(t.getGatewayAppId(), 'gw')
  t.deleteAppIdbyAppId('gw')
  assert.equal(t.getGatewayPeerId(), undefined)
  assert.equal(t.getGatewayAppId(), undefined)
})

test('listAppId 含 offline，listOnlineAppId 只含 online', () => {
  const t = new PeerAppConnectionTable()
  t.bind('a', 'p1'); t.bind('b', 'p1'); t.bind('c', 'p2')
  t.markOffline('b')
  assert.deepEqual(t.listAppId(), ['a', 'b', 'c'])
  assert.deepEqual(t.listOnlineAppId(), ['a', 'c'])
})

// ── measureBytes ──

test('Buffer/TypedArray 按精确 byteLength 计，大二进制主导总量', () => {
  assert.equal(measureBytes(Buffer.alloc(1000)), 1000)
  assert.equal(measureBytes(new Uint8Array(500)), 500)
  assert.equal(measureBytes(new ArrayBuffer(32)), 32)
  // 对象壳 8 + 键 'p' 2 + 精确的 1000 —— cap 防的就是大 byte string，所以二进制按精确值
  assert.equal(measureBytes({ p: Buffer.alloc(1000) }), 1010)
})

test('measureBytes 深度受限 —— 深嵌套/自引用对象不炸栈，返回数字', () => {
  let deep = { leaf: 'x' }
  for (let i = 0; i < 20; i++) deep = { deep }
  assert.equal(typeof measureBytes(deep), 'number')
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(typeof measureBytes(cyclic), 'number')
})
