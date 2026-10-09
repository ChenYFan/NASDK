// Perf numbers are printed, never asserted — machine variance would only create false failures.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cborCodec } from '../../NACT/codec.ts'
import {
  FRAME_HEADER_SIZE, MAX_FRAME_SIZE, NACT_VERSION, MAGIC_BY_VERSION,
  packFrameHeader, checkFrameHeader, makeReassembler, makeFrameReceiver, splitAndEmit, toHex,
} from '../../NACT/framing.ts'
import { makeFrameSplitter } from '../../packages/nact-provider-shared/index.ts'
import { NACTError } from '../../NACT/errors.ts'
import { sleep, timed, rate } from '../_kit.mjs'

const SLOW = !!process.env.NASDK_SLOW

const envelope = (payload) => ({
  v: { major: 1, minor: 0 }, type: 'notify', id: 'e1', from: 'a', to: 'b', t: 1,
  meta: { parentId: 'p', targetSubName: 'x', hitSubName: 'x' }, payload,
})

/** Split → reassemble → decode; returns [result, frame count]. */
function roundTrip(msg, chunkSize) {
  const bytes = cborCodec.encode(msg)
  let got = null, frames = 0
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(`reasm: ${r}`))
  splitAndEmit(bytes, chunkSize, (header, body) => {
    frames++
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const id = toHex(header.subarray(0, 16))
    const offset = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(body, offset)
    reasm.advance(id, offset, body.length)
  })
  return [got, frames]
}

// ── codec limits ──

test('1MB payload 编解码往返，字节级一致', async () => {
  const big = 'X'.repeat(1024 * 1024)
  const msg = envelope({ big })

  const [bytes, encMs] = await timed(async () => cborCodec.encode(msg))
  const [back, decMs] = await timed(async () => cborCodec.decode(bytes))

  assert.equal(back.payload.big.length, big.length)
  assert.equal(back.payload.big, big)
  console.log(`    ${rate('encode 1MB', bytes.length, encMs)}`)
  console.log(`    ${rate('decode 1MB', bytes.length, decMs)}`)
})

test('1MB 二进制 payload（Uint8Array 不走字符串路径）', async () => {
  const bin = new Uint8Array(1024 * 1024)
  for (let i = 0; i < bin.length; i++) bin[i] = i & 0xff
  const [bytes, ms] = await timed(async () => cborCodec.encode(envelope({ bin })))
  const back = cborCodec.decode(bytes)

  assert.equal(back.payload.bin.length, bin.length)
  assert.deepEqual(back.payload.bin.subarray(0, 256), bin.subarray(0, 256))
  assert.equal(back.payload.bin[bin.length - 1], bin[bin.length - 1], '最后一个字节也对')
  console.log(`    ${rate('encode 1MB binary', bytes.length, ms)}`)
})

test('深嵌套 200 层不炸栈', () => {
  let deep = { leaf: true }
  for (let i = 0; i < 200; i++) deep = { d: deep }
  const back = cborCodec.decode(cborCodec.encode(envelope(deep)))
  let n = 0, cur = back.payload
  while (cur.d) { cur = cur.d; n++ }
  assert.equal(n, 200)
  assert.equal(cur.leaf, true)
})

test('宽对象 10000 键', async () => {
  const wide = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`k${i}`, i]))
  const [bytes, ms] = await timed(async () => cborCodec.encode(envelope(wide)))
  const back = cborCodec.decode(bytes)
  assert.equal(Object.keys(back.payload).length, 10000)
  assert.equal(back.payload.k9999, 9999)
  console.log(`    10000 keys: ${bytes.length} bytes in ${ms.toFixed(1)}ms`)
})

// ── fragmentation limits ──

test('chunkSize = 1：每帧体一字节，1MB 会分片成几十万帧', async () => {
  // bodyMax is at least 1, so chunkSize below header size still works — frames just explode.
  // 8KB instead of 1MB: 1MB × 33B/frame overhead ≈ 34MB wire bytes, slow and uninformative.
  const msg = envelope({ s: 'y'.repeat(8 * 1024) })
  const [[got, frames], ms] = await timed(async () => roundTrip(msg, 1))
  assert.deepEqual(got, msg)
  const bytes = cborCodec.encode(msg).length
  assert.ok(frames >= bytes, `每帧至多 1 字节体，${bytes} 字节分片成 ${frames} 帧`)
  console.log(`    chunkSize=1: ${bytes}B → ${frames} 帧, ${ms.toFixed(1)}ms（帧头开销 ${FRAME_HEADER_SIZE}B/帧）`)
})

test('chunkSize = 64：1MB 分片成 ~16000 帧仍能重组', async () => {
  const msg = envelope({ big: 'Z'.repeat(1024 * 1024) })
  const [[got, frames], ms] = await timed(async () => roundTrip(msg, 64))
  assert.equal(got.payload.big.length, 1024 * 1024)
  assert.equal(got.payload.big, msg.payload.big)
  console.log(`    chunkSize=64: ${frames} 帧, ${ms.toFixed(1)}ms`)
})

test('chunkSize 正好等于 FRAME_HEADER_SIZE + 1：每帧体恰好 1 字节', () => {
  const msg = envelope({ s: 'abcdefghij' })
  const [got, frames] = roundTrip(msg, FRAME_HEADER_SIZE + 1)
  assert.deepEqual(got, msg)
  const bytes = cborCodec.encode(msg).length
  assert.equal(frames, bytes, `${bytes} 字节 → ${frames} 帧，一帧一字节`)
})

test('极端乱序：1000 帧完全打乱后重组', () => {
  const msg = envelope({ blob: 'q'.repeat(64 * 1024) })
  const bytes = cborCodec.encode(msg)
  const frames = []
  splitAndEmit(bytes, 128, (h, b) => frames.push({ h: Uint8Array.from(h), b: Uint8Array.from(b) }))
  assert.ok(frames.length > 400, `分片成 ${frames.length} 帧`)

  // Deterministic shuffle (i*7919 % n), not Math.random — failures must reproduce.
  const order = []
  for (let i = 0; i < frames.length; i++) order.push((i * 7919) % frames.length)
  const shuffled = [...new Set(order)].map(i => frames[i])
  assert.equal(shuffled.length, frames.length, '每帧恰好来一次')

  let got = null
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
  for (const { h, b } of shuffled) {
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    const id = toHex(h.subarray(0, 16))
    const off = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(b, off)
    reasm.advance(id, off, b.length)
  }
  assert.equal(got.payload.blob, msg.payload.blob)
})

test('100 个包的帧全部交错，各自重组不串', () => {
  const msgs = Array.from({ length: 100 }, (_, i) => envelope({ tag: i, pad: `${i}`.repeat(200) }))
  const per = msgs.map(m => {
    const out = []
    splitAndEmit(cborCodec.encode(m), 256, (h, b) => out.push({ h: Uint8Array.from(h), b: Uint8Array.from(b) }))
    return out
  })

  const done = []
  const reasm = makeReassembler((full) => done.push(cborCodec.decode(full)), (r) => assert.fail(r))
  const feed = ({ h, b }) => {
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    const id = toHex(h.subarray(0, 16))
    const off = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(b, off)
    reasm.advance(id, off, b.length)
  }
  const maxLen = Math.max(...per.map(p => p.length))
  for (let i = 0; i < maxLen; i++) for (const p of per) if (p[i]) feed(p[i])

  assert.equal(done.length, 100)
  assert.deepEqual(done.map(d => d.payload.tag).sort((a, b) => a - b), msgs.map(m => m.payload.tag))
})

// ── bad bytes: every rejection reason ──

test('帧长越界的两端：比头还小 / 超过 MAX_FRAME_SIZE —— 切帧与逐帧接收都拒', () => {
  for (const [size, code] of [[FRAME_HEADER_SIZE - 1, 'frame-too-small'], [MAX_FRAME_SIZE + 1, 'frame-too-large']]) {
    const h = packFrameHeader(new Uint8Array(16), 0, 100, 0)
    new DataView(h.buffer, h.byteOffset, h.byteLength).setUint32(24, size)

    const errs = []
    makeFrameSplitter(() => assert.fail('不该切出帧'), (e) => errs.push(e.code))(h)
    assert.deepEqual(errs, [code], `切帧 frameSize=${size}`)

    if (code === 'frame-too-large') {
      const rx = makeFrameReceiver(() => {}, () => {})
      assert.throws(() => rx.receive([h]), (e) => {
        assert.ok(e instanceof NACTError)
        assert.equal(e.code, code)
        assert.equal(e.phase, 'inbound')
        return true
      }, `逐帧接收 frameSize=${size}`)
    }
  }
})

test('帧长正好等于 FRAME_HEADER_SIZE（空体）是合法的', () => {
  const h = packFrameHeader(new Uint8Array(16), 0, 0, 0)
  assert.equal(new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(24), FRAME_HEADER_SIZE)
  assert.equal(checkFrameHeader(h), null, '空体不是错误，边界包含')
})

test('版本与 magic 的四种组合', () => {
  const good = packFrameHeader(new Uint8Array(16), 0, 10, 0)
  const mk = (magic, version) => {
    const h = Uint8Array.from(good)
    h[30] = magic; h[31] = version
    return h
  }
  const M = MAGIC_BY_VERSION[NACT_VERSION]

  assert.equal(checkFrameHeader(mk(M, NACT_VERSION)), null, '都对')
  assert.equal(checkFrameHeader(mk(M, 0x99)), 'version-mismatch', '版本错 → 先报版本')
  assert.equal(checkFrameHeader(mk(0x00, 0x99)), 'version-mismatch', '都错也先报版本 —— 版本不认就不谈 magic')
  assert.equal(checkFrameHeader(mk(0x00, NACT_VERSION)), 'bad-magic', '只有 magic 错')
})

test('重组的两种拒绝：越界 / 重叠', () => {
  for (const [total, off, len, want] of [
    [100, 80, 40, 'frame-out-of-bounds'],   // 80+40 > 100
    [100, 0, 101, 'frame-out-of-bounds'],   // single frame exceeds total
  ]) {
    const errs = []
    const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
    reasm.ensure('k', total)
    reasm.advance('k', off, len)
    assert.deepEqual(errs, [want], `total=${total} off=${off} len=${len}`)
  }

  const errs = []
  const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
  reasm.ensure('k', 100)
  reasm.advance('k', 0, 60)
  reasm.advance('k', 50, 50)     // [50,100) overlaps [0,60)
  assert.deepEqual(errs, ['overlapping-frame'])
})

test('字节流：每次喂 1 字节，切帧 + 逐帧接收都不丢', async () => {
  const msg = envelope({ blob: 'w'.repeat(4096) })
  const parts = []
  splitAndEmit(cborCodec.encode(msg), 512, (h, b) => { parts.push(h, b) })
  const total = parts.reduce((n, p) => n + p.length, 0)
  const wire = new Uint8Array(total)
  let at = 0
  for (const p of parts) { wire.set(p, at); at += p.length }

  let got = null
  const rx = makeFrameReceiver((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
  const push = makeFrameSplitter((frame) => rx.receive(frame), (e) => assert.fail(e.message))
  const [, ms] = await timed(async () => {
    for (let i = 0; i < wire.length; i++) push(wire.subarray(i, i + 1))
  })
  assert.deepEqual(got, msg)
  console.log(`    ${wire.length} 次单字节 push: ${ms.toFixed(1)}ms`)
})

test('字节流：一个大 chunk 里塞 1000 个小帧，全部切出并零拷贝', () => {
  const msgs = Array.from({ length: 1000 }, (_, i) => envelope({ i }))
  const parts = []
  for (const m of msgs) splitAndEmit(cborCodec.encode(m), 1024, (h, b) => { parts.push(h, b) })
  const wire = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { wire.set(p, at); at += p.length }

  const got = []
  let copied = 0
  const rx = makeFrameReceiver((full) => {
    if (full.buffer !== wire.buffer) copied++
    got.push(cborCodec.decode(full).payload.i)
  }, (r) => assert.fail(r))
  makeFrameSplitter((frame) => rx.receive(frame), (e) => assert.fail(e.message))(wire)
  assert.deepEqual(got, msgs.map(m => m.payload.i))
  assert.equal(copied, 0, '单帧包且整帧在一个 chunk 内：从 socket chunk 到解码全程零拷贝')
})

// ── timeout paths (skipped by default: really waits 30s+) ──

test('重组超时：只发半个消息，30s 后报 reassembly-timeout', { skip: !SLOW }, async () => {
  // REASSEMBLY_TIMEOUT_MS = 30s; this test must actually wait, hence skipped by default.
  const errs = []
  const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
  reasm.ensure('half', 1000)
  reasm.advance('half', 0, 400)          // remaining 600 bytes never arrive
  const [, ms] = await timed(() => sleep(31_000))
  assert.deepEqual(errs, ['reassembly-timeout'], `等了 ${ms.toFixed(0)}ms`)
  console.log(`    reassembly-timeout 于 ${ms.toFixed(0)}ms 触发`)
})
