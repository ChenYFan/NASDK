/**
 * full/nact — 覆盖传输层正常会走到的路径。
 *
 * 单测为主（framing / codec 是纯函数），最后几条起真 carrier 验证 Peer 生命周期和三种承载的等价性。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { cborCodec } from '../../NACT/codec.ts'
import {
  FRAG_HEADER, MAX_FRAME_SIZE, DEFAULT_CHUNK, DEFAULT_HEARTBEAT_MS, NACT_VERSION, MAGIC_BY_VERSION,
  checkFragHeader, packFragHeader, makeReassembler, makeStreamParser, splitAndEmit, toHex,
} from '../../NACT/framing.ts'
import { NACTError } from '../../NACT/errors.ts'
import { NACTEvent } from '../../NACT/events.ts'
import { startApp, startPair, tcp, ws, unix, PORT, sleep } from '../_kit.mjs'

const aMsg = (payload) => ({
  v: { major: 1, minor: 0 }, type: 'notify', id: 'm1', from: 'a', to: 'b', t: 1,
  meta: { parentId: 'p', targetSubName: 'x', hitSubName: 'x' }, payload,
})

/** 把一条消息切片后拼成连续的线上字节（tcp/unix 的线格式）。 */
function toWire(bytes, chunkSize) {
  const parts = []
  splitAndEmit(bytes, chunkSize, (h, b) => { parts.push(h, b) })
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** 用 reassembler 吃完 splitAndEmit 的所有分片，返回解码结果。 */
function roundTrip(msg, chunkSize) {
  const bytes = cborCodec.encode(msg)
  let got = null, frames = 0
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(`reasm error: ${r}`))
  splitAndEmit(bytes, chunkSize, (header, body) => {
    frames++
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const id = toHex(header.subarray(0, 16))
    const offset = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(body, offset)
    reasm.advance(id, offset, body.length)
  })
  return { got, frames }
}

// ── codec ──

test('codec 覆盖各种 payload 类型', () => {
  const cases = [
    {}, null, 0, '', false,
    { deep: { nested: { arr: [1, 'two', null, true] } } },
    { bin: new Uint8Array([0, 127, 128, 255]) },
    { big: 2 ** 40 },
    { neg: -1.5 },
    { unicode: '中文🎉' },
    { many: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])) },
  ]
  for (const payload of cases) {
    const back = cborCodec.decode(cborCodec.encode(aMsg(payload)))
    assert.deepEqual(back.payload, payload, `payload = ${JSON.stringify(payload)?.slice(0, 40)}`)
  }
})

test('codec：信封字段一个不丢', () => {
  const msg = aMsg({ x: 1 })
  assert.deepEqual(cborCodec.decode(cborCodec.encode(msg)), msg)
})

test('codec.decode 接受 Uint8Array 和 ArrayBuffer', () => {
  const bytes = cborCodec.encode(aMsg({ x: 1 }))
  assert.deepEqual(cborCodec.decode(bytes), aMsg({ x: 1 }))
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  assert.deepEqual(cborCodec.decode(ab), aMsg({ x: 1 }))
})

test('codec.decode 遇到垃圾字节抛错', () => {
  assert.throws(() => cborCodec.decode(new Uint8Array([0xff, 0xff, 0xff, 0xff])))
})

// ── 分片头 ──

test('头布局：16B msgId + offset + totalSize + thisFrameSize + 保留 + magic + version', () => {
  const msgId = new Uint8Array(16).fill(0xab)
  const h = packFragHeader(msgId, 100, 5000, 200)
  assert.equal(h.length, 32)

  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  assert.equal(toHex(h.subarray(0, 16)), 'ab'.repeat(16))
  assert.equal(dv.getUint32(16), 100, 'offset')
  assert.equal(dv.getUint32(20), 5000, 'totalSize')
  assert.equal(dv.getUint32(24), FRAG_HEADER + 200, 'thisFrameSize')
  assert.equal(dv.getUint16(28), 0, '保留位')
  assert.equal(dv.getUint8(31), NACT_VERSION, 'version 在最后一个字节 —— 跨版本唯一位置稳定的字段')
  assert.equal(checkFragHeader(h), null)
})

test('版本先判、magic 后判', () => {
  const h = packFragHeader(new Uint8Array(16), 0, 10, 10)

  const badBoth = Uint8Array.from(h); badBoth[30] = 0; badBoth[31] = 99
  assert.equal(checkFragHeader(badBoth), 'version-mismatch', '版本不认就不谈 magic')

  const badMagic = Uint8Array.from(h); badMagic[30] = 0
  assert.equal(checkFragHeader(badMagic), 'bad-magic')
})

test('msgId 每条消息不同，同条消息内相同', () => {
  const b = cborCodec.encode(aMsg({ blob: 'x'.repeat(5000) }))
  const ids1 = new Set(); const ids2 = new Set()
  splitAndEmit(b, 1024, (h) => ids1.add(toHex(h.subarray(0, 16))))
  splitAndEmit(b, 1024, (h) => ids2.add(toHex(h.subarray(0, 16))))
  assert.equal(ids1.size, 1)
  assert.equal(ids2.size, 1)
  assert.notDeepEqual([...ids1], [...ids2], '两次发送是两个 msgId')
})

// ── 切片 / 重组 ──

test('切片数量随 chunkSize 变化，结果始终一致', () => {
  const msg = aMsg({ blob: 'q'.repeat(20 * 1024) })
  let prev = Infinity
  for (const chunkSize of [64, 256, 1024, 8192, DEFAULT_CHUNK.tcp]) {
    const { got, frames } = roundTrip(msg, chunkSize)
    assert.deepEqual(got, msg, `chunkSize=${chunkSize}`)
    assert.ok(frames <= prev, `chunkSize 越大片数越少：${chunkSize} → ${frames}`)
    prev = frames
  }
})

test('chunkSize 比头还小也能工作 —— bodyMax 至少 1', () => {
  const msg = aMsg({ s: 'abcdefgh' })
  const { got, frames } = roundTrip(msg, 1)
  assert.deepEqual(got, msg)
  assert.ok(frames > 10, `每片体只有 1 字节，切了 ${frames} 片`)
})

test('空消息、1 字节、正好等于 chunkSize 的边界', () => {
  for (const payload of [{}, { s: '' }, { s: 'a' }]) {
    const { got } = roundTrip(aMsg(payload), 1024)
    assert.deepEqual(got, aMsg(payload))
  }
  // 让编码后长度正好落在一片能装下的上限附近
  const bodyMax = 1024 - FRAG_HEADER
  for (const delta of [-1, 0, 1]) {
    const filler = 'z'.repeat(Math.max(1, bodyMax + delta - 80))
    const { got } = roundTrip(aMsg({ filler }), 1024)
    assert.equal(got.payload.filler.length, filler.length)
  }
})

test('分片乱序到达也能重组', () => {
  const msg = aMsg({ blob: 'r'.repeat(10 * 1024) })
  const bytes = cborCodec.encode(msg)
  const frames = []
  splitAndEmit(bytes, 512, (h, b) => frames.push({ h, b: Uint8Array.from(b) }))

  let got = null
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
  for (const { h, b } of [...frames].reverse()) {       // 倒序喂进去
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    const id = toHex(h.subarray(0, 16))
    const off = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(b, off)
    reasm.advance(id, off, b.length)
  }
  assert.deepEqual(got, msg)
})

test('两条消息的分片交错到达，各自重组', () => {
  const m1 = aMsg({ tag: 'one', blob: 'a'.repeat(3000) })
  const m2 = aMsg({ tag: 'two', blob: 'b'.repeat(3000) })
  const collect = (msg) => {
    const out = []
    splitAndEmit(cborCodec.encode(msg), 512, (h, b) => out.push({ h, b: Uint8Array.from(b) }))
    return out
  }
  const f1 = collect(m1), f2 = collect(m2)

  const done = []
  const reasm = makeReassembler((full) => done.push(cborCodec.decode(full)), (r) => assert.fail(r))
  const feed = ({ h, b }) => {
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    const id = toHex(h.subarray(0, 16))
    const off = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(b, off)
    reasm.advance(id, off, b.length)
  }
  for (let i = 0; i < Math.max(f1.length, f2.length); i++) { f1[i] && feed(f1[i]); f2[i] && feed(f2[i]) }

  assert.equal(done.length, 2)
  assert.deepEqual(done.map(d => d.payload.tag).sort(), ['one', 'two'])
})

test('重复的片被拒（received 计数骗不过区间集）', () => {
  const errs = []
  const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
  reasm.ensure('d', 100)
  reasm.advance('d', 0, 50)
  reasm.advance('d', 0, 50)       // 同一段来两次：计数会凑满 100，但区间重叠
  assert.deepEqual(errs, ['overlapping-fragment'])
})

test('advance 到未知 msgId 是静默空操作', () => {
  const errs = []
  const reasm = makeReassembler(() => {}, (r) => errs.push(r))
  assert.doesNotThrow(() => reasm.advance('从未 ensure 过', 0, 10))
  assert.deepEqual(errs, [])
})

test('clear 之后旧 msgId 的片不再累积', () => {
  let done = 0
  const reasm = makeReassembler(() => done++, () => {})
  reasm.ensure('x', 100)
  reasm.advance('x', 0, 50)
  reasm.clear()
  reasm.advance('x', 50, 50)      // 表已清，这片无处可去
  assert.equal(done, 0)
})

// ── 裸流解析 ──

test('裸流：任意分块都能还原', () => {
  const msg = aMsg({ blob: 'w'.repeat(8000) })
  const wire = toWire(cborCodec.encode(msg), 512)

  for (const chunk of [1, 3, 31, 512, 1024, wire.length, wire.length * 2]) {
    let got = null
    const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
    const parse = makeStreamParser(reasm)
    for (let i = 0; i < wire.length; i += chunk) parse(wire.subarray(i, i + chunk))
    assert.deepEqual(got, msg, `按 ${chunk} 字节喂`)
  }
})

test('裸流：连续多条消息', () => {
  const msgs = [aMsg({ n: 1 }), aMsg({ n: 2, blob: 'x'.repeat(2000) }), aMsg({ n: 3 })]
  const chunks = msgs.map(m => toWire(cborCodec.encode(m), 512))
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const wire = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { wire.set(c, at); at += c.length }

  const got = []
  const reasm = makeReassembler((full) => got.push(cborCodec.decode(full)), (r) => assert.fail(r))
  const parse = makeStreamParser(reasm)
  for (let i = 0; i < wire.length; i += 7) parse(wire.subarray(i, i + 7))

  assert.deepEqual(got.map(g => g.payload.n), [1, 2, 3])
})

test('裸流：头里的 frameSize 越界要抛 NACTError', () => {
  const h = packFragHeader(new Uint8Array(16), 0, 100, 0)
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)

  dv.setUint32(24, FRAG_HEADER - 1)          // 比头还小
  let parse = makeStreamParser(makeReassembler(() => {}, () => {}))
  assert.throws(() => parse(h), (e) => e instanceof NACTError && e.code === 'frame-too-small')

  dv.setUint32(24, MAX_FRAME_SIZE + 1)       // 超过上限
  parse = makeStreamParser(makeReassembler(() => {}, () => {}))
  assert.throws(() => parse(h), (e) => e instanceof NACTError && e.code === 'frame-too-large')
})

test('裸流：坏头抛 NACTError，且 layer/phase 都填对', () => {
  const h = packFragHeader(new Uint8Array(16), 0, 10, 0)
  h[31] = 99
  const parse = makeStreamParser(makeReassembler(() => {}, () => {}))
  assert.throws(() => parse(h), (e) => {
    assert.ok(e instanceof NACTError)
    assert.equal(e.code, 'version-mismatch')
    assert.equal(e.layer, 'NACT', 'layer 恒为 NACT')
    assert.equal(e.phase, 'inbound', '坏字节进来是 inbound —— 三个工厂分相就是为了这个')
    return true
  })
})

test('越界的片被拒（offset+len 超出 totalSize）', () => {
  const errs = []
  const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
  reasm.ensure('b', 100)
  reasm.advance('b', 80, 40)          // 80+40 > 100
  assert.deepEqual(errs, ['fragment-out-of-bounds'])
})

// ── 常量 ──

test('默认值都在合理范围', () => {
  assert.equal(FRAG_HEADER, 32)
  assert.equal(MAX_FRAME_SIZE, 2 * 1024 * 1024 * 1024)
  assert.equal(DEFAULT_HEARTBEAT_MS, 30_000)
  for (const t of ['tcp', 'unix', 'ws']) {
    assert.ok(DEFAULT_CHUNK[t] > FRAG_HEADER, `${t} 的默认 chunk 大于头`)
  }
})

test('当前版本在 magic 表里，且 packFragHeader 写的就是表里那个', () => {
  assert.ok(NACT_VERSION in MAGIC_BY_VERSION, `v${NACT_VERSION} 有对应 magic`)
  const h = packFragHeader(new Uint8Array(16), 0, 10, 0)
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  assert.equal(dv.getUint8(30), MAGIC_BY_VERSION[NACT_VERSION], 'magic 取自版本表而不是写死')
})

// ── 真 carrier ──

test('peer 表：连上入表、断开离表，disconnect 只报一次且带走的是那个 peerId', async () => {
  const spec = tcp(PORT.nact)
  const { srv, cli, stop } = await startPair(spec)

  assert.equal(srv.nact.listPeerId().length, 1, '服务端有一个 peer')
  assert.equal(cli.nact.listPeerId().length, 1)

  const peerId = srv.nact.listPeerId()[0]
  const announced = []
  srv.bus.listen(NACTEvent.peerDisconnect, (p) => announced.push(p.peerId))

  await cli.disconnect('srv')
  await sleep(60)

  assert.equal(announced.length, 1, `断开只announce一次，实得 ${announced.length}`)
  assert.equal(announced[0], peerId, 'payload 里是具体走掉的那个 peerId，不是随便一个')
  assert.equal(srv.nact.listPeerId().length, 0, '服务端 peer 表清空')

  await stop()
})

test('connect 事件：入表和 announce 是同一件事', async () => {
  const spec = tcp(PORT.nact + 12)
  const { app: srv, stop: stopSrv } = await startApp('srv', { server: [spec] })

  // 在对端拨进来之前就挂上，否则 connect 早于订阅
  const seen = []
  srv.bus.listen(NACTEvent.peerConnect, (p) => seen.push(p.peerId))

  const { app: cli, stop: stopCli } = await startApp('cli')
  await cli.connect('srv', spec)
  await sleep(60)

  assert.equal(seen.length, 1, '一条连接 announce 一次')
  assert.deepEqual(seen, srv.nact.listPeerId(), 'announce 的 peerId 就是表里那个')

  await stopCli(); await stopSrv()
})

test('closePeer 的 resolve 是等 disconnect 事件等来的', async () => {
  const spec = tcp(PORT.nactWs)
  const { cli, stop } = await startPair(spec)

  const peerId = cli.nact.listPeerId()[0]
  // closePeer 内部就是订阅 peerDisconnect 来 settle 的，所以事件必然先于 resolve
  let announcedAt = -1, n = 0
  cli.bus.listen(NACTEvent.peerDisconnect, (p) => { if (p.peerId === peerId) announcedAt = ++n })

  assert.equal(await cli.nact.closePeer(peerId), true)
  assert.equal(announcedAt, 1, 'resolve 时 disconnect 已经播过了')
  assert.equal(cli.nact.getPeer(peerId), undefined, 'resolve 后表里已经没有它')
  assert.equal(cli.nact.closePeer(peerId) instanceof Promise, true, '没这个 peer 也返 Promise，不是 undefined')
  assert.equal(await cli.nact.closePeer(peerId), false, '再关一次返 false')

  await stop()
})

test('sendToPeer：找到就 true，找不到就 false', async () => {
  const spec = tcp(PORT.nact + 13)
  const { cli, stop } = await startPair(spec)

  assert.equal(cli.nact.sendToPeer('不存在的 peer', aMsg({})), false)
  assert.equal(cli.nact.sendToPeer(cli.nact.listPeerId()[0], aMsg({})), true, '真 peer 上返 true')

  await stop()
})

test('addPeer / getPeer / dropPeer / listPeerId 是一套自洽的表操作', async () => {
  const { app, stop } = await startApp('table')
  const fake = { id: 'p-手搓', send() {}, close() {} }

  assert.equal(app.nact.getPeer('p-手搓'), undefined, '还没加')
  app.nact.addPeer(fake)
  assert.equal(app.nact.getPeer('p-手搓'), fake, 'getPeer 拿回同一个对象')
  assert.deepEqual(app.nact.listPeerId(), ['p-手搓'])

  assert.equal(app.nact.dropPeer('p-手搓'), true, '真删掉了返 true')
  assert.equal(app.nact.dropPeer('p-手搓'), false, '重复 drop 可见，不静默')
  assert.deepEqual(app.nact.listPeerId(), [])

  // addPeer 按 peer.id 覆盖：同 id 再加是替换而不是并存
  const dupA = { id: 'dup', send() {}, close() {} }
  const dupB = { id: 'dup', send() {}, close() {} }
  app.nact.addPeer(dupA)
  app.nact.addPeer(dupB)
  assert.equal(app.nact.listPeerId().length, 1, '同 id 只有一行')
  assert.equal(app.nact.getPeer('dup'), dupB, '后加的那个赢')

  await stop()
})

test('listen 的 onPeer 拿到的 peer 已经在表里了', async () => {
  const spec = tcp(PORT.nact + 14)
  const { app: srv, stop: stopSrv } = await startApp('srv')

  const handed = []
  const handle = await srv.nact.listen(spec, (peer) => handed.push(peer))

  const { app: cli, stop: stopCli } = await startApp('cli')
  await cli.connect('srv', spec)
  await sleep(60)

  assert.equal(handed.length, 1, 'onPeer 收到这条连接')
  assert.equal(srv.nact.getPeer(handed[0].id), handed[0], '交到 onPeer 手上时已入表 —— 握手不用自己补登记')
  assert.equal(typeof handle.close, 'function', 'listen 返回的 handle 能关')

  await stopCli(); await stopSrv()
})

test('terminate：peer 表清空、且teardown 期间不播 disconnect', async () => {
  const spec = tcp(PORT.nact + 15)
  const { app: srv, stop: stopSrv } = await startApp('srv', { server: [spec] })
  const { app: cli } = await startApp('cli')
  await cli.connect('srv', spec)
  await sleep(60)
  assert.equal(srv.nact.listPeerId().length, 1)

  const announced = []
  srv.bus.listen(NACTEvent.peerDisconnect, (p) => announced.push(p.peerId))

  await srv.nact.terminate()
  await sleep(80)                       // 给 socket 的 close 事件留出到达时间

  assert.equal(srv.nact.listPeerId().length, 0, '整层 teardown 后表是空的')
  assert.equal(announced.length, 0,
    `terminate 是安静的：表先清空，socket 的 close 到达时 gone 找不到行可删，就不 announce。实得 ${announced.length} 条`)

  await stopSrv()
})

test('三种 carrier 传同一条大消息，结果一致', async (t) => {
  const big = 'M'.repeat(120 * 1024)
  for (const [name, spec] of [
    ['tcp', tcp(PORT.nact + 5)],
    ['ws', ws(PORT.nact + 6)],
    ['unix', unix('nact-full')],
  ]) {
    await t.test(name, async () => {
      const { srv, cli, stop } = await startPair(spec)
      const res = await cli.request('srv', { kind: 'ability', target: 'echo', payload: { big } }).response
      assert.equal(res.payload.big.length, big.length)
      assert.equal(res.payload.big, big)
      // Peer 抽象是承载无关的：不管底下是 socket 还是 ws 帧，上面看到的都是一行 peer
      assert.equal(cli.nact.listPeerId().length, 1, `${name}: 客户端一行 peer`)
      assert.equal(srv.nact.listPeerId().length, 1, `${name}: 服务端一行 peer`)
      await stop()
    })
  }
})

test('自定义 chunkSize 生效：小 chunk 迫使大量分片，消息仍完整', async () => {
  const spec = tcp(PORT.nact + 7, { chunkSize: 512 })
  const { cli, stop } = await startPair(spec)
  const big = 'C'.repeat(60 * 1024)     // 512 字节一片 → 120+ 片
  const res = await cli.request('srv', { kind: 'ability', target: 'echo', payload: { big } }).response
  assert.equal(res.payload.big, big)
  await stop()
})

test('heartbeat: -1 关闭心跳，连接照常工作', async () => {
  const spec = tcp(PORT.nact + 8, { heartbeat: -1 })
  const { cli, stop } = await startPair(spec)
  const res = await cli.request('srv', { kind: 'ability', target: 'add', payload: { a: 1, b: 1 } }).response
  assert.equal(res.payload, 2)
  await stop()
})

test('listen 到被占用的端口要抛错', async () => {
  const port = PORT.nact + 9
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r))

  const { app, stop } = await startApp('taken')
  await assert.rejects(app.nact.listen(tcp(port)), (e) => {
    assert.equal(e.code, 'EADDRINUSE')
    return true
  })

  await stop()
  await new Promise((r) => blocker.close(r))
})

test('dial 到没人监听的端口要抛错', async () => {
  const { app, stop } = await startApp('nobody')
  await assert.rejects(app.nact.dial(tcp(PORT.nact + 10)), (e) => e.code === 'ECONNREFUSED')
  await stop()
})

test('terminate 之后端口能立刻被复用', async () => {
  const spec = tcp(PORT.nact + 11)
  for (let i = 0; i < 3; i++) {
    const { app, stop } = await startApp(`round-${i}`, { server: [spec] })
    assert.ok(app)
    await stop()
  }
})
