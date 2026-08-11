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
  FRAG_HEADER, MAX_FRAME_SIZE, DEFAULT_CHUNK, DEFAULT_HEARTBEAT_MS, NACT_VERSION,
  checkFragHeader, packFragHeader, makeReassembler, makeStreamParser, splitAndEmit, toHex,
} from '../../NACT/framing.ts'
import { NACTError } from '../../NACT/errors.ts'
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

test('裸流：坏头抛 NACTError', () => {
  const h = packFragHeader(new Uint8Array(16), 0, 10, 0)
  h[31] = 99
  const parse = makeStreamParser(makeReassembler(() => {}, () => {}))
  assert.throws(() => parse(h), (e) => e instanceof NACTError && e.code === 'version-mismatch')
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

// ── 真 carrier ──

test('peer 表：连上入表、断开离表，disconnect 只报一次', async () => {
  const spec = tcp(PORT.nact)
  const { srv, cli, stop } = await startPair(spec)

  assert.equal(srv.nact.listPeerId().length, 1, '服务端有一个 peer')
  assert.equal(cli.nact.listPeerId().length, 1)

  const announced = []
  srv.bus.listen('nact:peer:disconnect', (p) => announced.push(p.peerId))

  await cli.disconnect('srv')
  await sleep(60)

  assert.equal(announced.length, 1, `断开只announce一次，实得 ${announced.length}`)
  assert.equal(srv.nact.listPeerId().length, 0, '服务端 peer 表清空')

  await stop()
})

test('closePeer：resolve 时 peer 已离表', async () => {
  const spec = tcp(PORT.nactWs)
  const { cli, stop } = await startPair(spec)

  const peerId = cli.nact.listPeerId()[0]
  assert.equal(await cli.nact.closePeer(peerId), true)
  assert.equal(cli.nact.getPeer(peerId), undefined, 'resolve 后表里已经没有它')
  assert.equal(await cli.nact.closePeer(peerId), false, '再关一次返 false')

  await stop()
})

test('sendToPeer 对不存在的 peerId 返 false', async () => {
  const { app, stop } = await startApp('solo')
  assert.equal(app.nact.sendToPeer('不存在的 peer', aMsg({})), false)
  await stop()
})

test('三种 carrier 传同一条大消息，结果一致', async (t) => {
  const big = 'M'.repeat(120 * 1024)
  for (const [name, spec] of [
    ['tcp', tcp(PORT.nact + 5)],
    ['ws', ws(PORT.nact + 6)],
    ['unix', unix('nact-full')],
  ]) {
    await t.test(name, async () => {
      const { cli, stop } = await startPair(spec)
      const res = await cli.request('srv', { kind: 'ability', target: 'echo', payload: { big } })
      assert.equal(res.payload.big.length, big.length)
      assert.equal(res.payload.big, big)
      await stop()
    })
  }
})

test('自定义 chunkSize 生效：小 chunk 迫使大量分片，消息仍完整', async () => {
  const spec = tcp(PORT.nact + 7, { chunkSize: 512 })
  const { cli, stop } = await startPair(spec)
  const big = 'C'.repeat(60 * 1024)     // 512 字节一片 → 120+ 片
  const res = await cli.request('srv', { kind: 'ability', target: 'echo', payload: { big } })
  assert.equal(res.payload.big, big)
  await stop()
})

test('heartbeat: -1 关闭心跳，连接照常工作', async () => {
  const spec = tcp(PORT.nact + 8, { heartbeat: -1 })
  const { cli, stop } = await startPair(spec)
  const res = await cli.request('srv', { kind: 'ability', target: 'add', payload: { a: 1, b: 1 } })
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
