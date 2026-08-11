/**
 * edge/nact — 临界值与压力。
 *
 * full/nact 覆盖正常路径，这里挑边界：分片的极端 chunkSize、1MB 消息过三种承载、
 * 100 条并发连接、坏字节的每一种拒绝理由。
 *
 * 性能数字只打印不断言 —— 机器差异太大，设阈值只会制造假红。真正被断言的是「结果正确」
 * 和「没有卡死」，速度留给人看。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cborCodec } from '../../NACT/codec.ts'
import {
  FRAG_HEADER, MAX_FRAME_SIZE, NACT_VERSION, MAGIC_BY_VERSION,
  packFragHeader, checkFragHeader, makeReassembler, makeStreamParser, splitAndEmit, toHex,
} from '../../NACT/framing.ts'
import { NACTError } from '../../NACT/errors.ts'
import { NACTEvent } from '../../NACT/events.ts'
import { startApp, startPair, tcp, ws, unix, PORT, sleep, timed, rate } from '../_kit.mjs'

const SLOW = !!process.env.NASDK_SLOW

const envelope = (payload) => ({
  v: { major: 1, minor: 0 }, type: 'notify', id: 'e1', from: 'a', to: 'b', t: 1,
  meta: { parentId: 'p', targetSubName: 'x', hitSubName: 'x' }, payload,
})

/** 切片 → 重组 → 解码，返回 [结果, 片数]。 */
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

// ── codec 极限 ──

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

// ── 分片极限 ──

test('chunkSize = 1：每片体一字节，1MB 会切出几十万片', async () => {
  // bodyMax 至少 1，所以 chunkSize 比头还小也能工作 —— 只是片数爆炸。
  // 用 8KB 而不是 1MB：1MB × 每片 33 字节开销 ≈ 34MB 线上字节，跑得动但没有额外信息量。
  const msg = envelope({ s: 'y'.repeat(8 * 1024) })
  const [[got, frames], ms] = await timed(async () => roundTrip(msg, 1))
  assert.deepEqual(got, msg)
  const bytes = cborCodec.encode(msg).length
  assert.ok(frames >= bytes, `每片至多 1 字节体，${bytes} 字节切了 ${frames} 片`)
  console.log(`    chunkSize=1: ${bytes}B → ${frames} 片, ${ms.toFixed(1)}ms（头开销 ${FRAG_HEADER}B/片）`)
})

test('chunkSize = 64：1MB 切出 ~16000 片仍能重组', async () => {
  const msg = envelope({ big: 'Z'.repeat(1024 * 1024) })
  const [[got, frames], ms] = await timed(async () => roundTrip(msg, 64))
  assert.equal(got.payload.big.length, 1024 * 1024)
  assert.equal(got.payload.big, msg.payload.big)
  console.log(`    chunkSize=64: ${frames} 片, ${ms.toFixed(1)}ms`)
})

test('chunkSize 正好等于 FRAG_HEADER + 1：每片体恰好 1 字节', () => {
  const msg = envelope({ s: 'abcdefghij' })
  const [got, frames] = roundTrip(msg, FRAG_HEADER + 1)
  assert.deepEqual(got, msg)
  const bytes = cborCodec.encode(msg).length
  assert.equal(frames, bytes, `${bytes} 字节 → ${frames} 片，一片一字节`)
})

test('极端乱序：1000 片完全打乱后重组', () => {
  const msg = envelope({ blob: 'q'.repeat(64 * 1024) })
  const bytes = cborCodec.encode(msg)
  const frames = []
  splitAndEmit(bytes, 128, (h, b) => frames.push({ h: Uint8Array.from(h), b: Uint8Array.from(b) }))
  assert.ok(frames.length > 400, `切了 ${frames.length} 片`)

  // 洗牌用固定序（i*7919 % n），不用 Math.random —— 失败时要能复现
  const order = []
  for (let i = 0; i < frames.length; i++) order.push((i * 7919) % frames.length)
  const shuffled = [...new Set(order)].map(i => frames[i])
  assert.equal(shuffled.length, frames.length, '每片恰好来一次')

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

test('100 条消息的分片全部交错，各自重组不串', () => {
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

// ── 坏字节：每种拒绝理由 ──

test('帧长越界的两端：比头还小 / 超过 MAX_FRAME_SIZE', () => {
  for (const [size, code] of [[FRAG_HEADER - 1, 'frame-too-small'], [MAX_FRAME_SIZE + 1, 'frame-too-large']]) {
    const h = packFragHeader(new Uint8Array(16), 0, 100, 0)
    new DataView(h.buffer, h.byteOffset, h.byteLength).setUint32(24, size)
    const parse = makeStreamParser(makeReassembler(() => {}, () => {}))
    assert.throws(() => parse(h), (e) => {
      assert.ok(e instanceof NACTError)
      assert.equal(e.code, code)
      assert.equal(e.phase, 'inbound')
      return true
    }, `frameSize=${size}`)
  }
})

test('帧长正好等于 FRAG_HEADER（空体）是合法的', () => {
  const h = packFragHeader(new Uint8Array(16), 0, 0, 0)
  assert.equal(new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(24), FRAG_HEADER)
  assert.equal(checkFragHeader(h), null, '空体不是错误，边界包含')
})

test('版本与 magic 的四种组合', () => {
  const good = packFragHeader(new Uint8Array(16), 0, 10, 0)
  const mk = (magic, version) => {
    const h = Uint8Array.from(good)
    h[30] = magic; h[31] = version
    return h
  }
  const M = MAGIC_BY_VERSION[NACT_VERSION]

  assert.equal(checkFragHeader(mk(M, NACT_VERSION)), null, '都对')
  assert.equal(checkFragHeader(mk(M, 0x99)), 'version-mismatch', '版本错 → 先报版本')
  assert.equal(checkFragHeader(mk(0x00, 0x99)), 'version-mismatch', '都错也先报版本 —— 版本不认就不谈 magic')
  assert.equal(checkFragHeader(mk(0x00, NACT_VERSION)), 'bad-magic', '只有 magic 错')
})

test('重组的两种拒绝：越界 / 重叠', () => {
  for (const [total, off, len, want] of [
    [100, 80, 40, 'fragment-out-of-bounds'],   // 80+40 > 100
    [100, 0, 101, 'fragment-out-of-bounds'],   // 单片就超
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
  reasm.advance('k', 50, 50)     // [50,100) 和 [0,60) 重叠
  assert.deepEqual(errs, ['overlapping-fragment'])
})

test('裸流：每次喂 1 字节，1000 次调用都不丢', async () => {
  const msg = envelope({ blob: 'w'.repeat(4096) })
  const parts = []
  splitAndEmit(cborCodec.encode(msg), 512, (h, b) => { parts.push(h, b) })
  const total = parts.reduce((n, p) => n + p.length, 0)
  const wire = new Uint8Array(total)
  let at = 0
  for (const p of parts) { wire.set(p, at); at += p.length }

  let got = null
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
  const parse = makeStreamParser(reasm)
  const [, ms] = await timed(async () => {
    for (let i = 0; i < wire.length; i++) parse(wire.subarray(i, i + 1))
  })
  assert.deepEqual(got, msg)
  console.log(`    ${wire.length} 次单字节 parse: ${ms.toFixed(1)}ms`)
})

// ── 真 carrier 压力 ──

test('1MB 消息过三种承载', async (t) => {
  const big = 'M'.repeat(1024 * 1024)
  for (const [name, spec] of [
    ['tcp', tcp(PORT.edge)],
    ['ws', ws(PORT.edgeWs)],
    ['unix', unix('edge-nact-1mb')],
  ]) {
    await t.test(name, async () => {
      const { cli, stop } = await startPair(spec)
      const [res, ms] = await timed(() => cli.request('srv', { kind: 'ability', target: 'echo', payload: { big } }))
      assert.equal(res.payload.big.length, big.length)
      assert.equal(res.payload.big, big, '字节级一致，不是长度对就算')
      console.log(`    ${rate(`${name} 1MB round-trip`, big.length * 2, ms)}`)
      await stop()
    })
  }
})

test('chunkSize=64 逼出大量分片，1MB 仍完整', async () => {
  const spec = tcp(PORT.edgeChunk, { chunkSize: 64 })
  const { cli, stop } = await startPair(spec)
  const big = 'C'.repeat(1024 * 1024)
  const [res, ms] = await timed(() => cli.request('srv', { kind: 'ability', target: 'echo', payload: { big } }))
  assert.equal(res.payload.big, big)
  console.log(`    ${rate('tcp chunkSize=64 1MB', big.length * 2, ms)}（~${Math.ceil(big.length / 32)} 片）`)
  await stop()
})

test('100 条并发连接：全连上、全在表、全断干净', async () => {
  const spec = tcp(PORT.edgeMany)
  const { app: srv, stop: stopSrv } = await startApp('srv', { server: [spec] })

  const N = 100
  const connects = []
  srv.bus.listen(NACTEvent.peerConnect, (p) => connects.push(p.peerId))

  const [clients, connMs] = await timed(async () => {
    const made = []
    for (let i = 0; i < N; i++) {
      const { app, stop } = await startApp(`c${i}`)
      await app.connect('srv', spec)
      made.push({ app, stop })
    }
    return made
  })
  await sleep(200)

  assert.equal(srv.nact.listPeerId().length, N, `服务端 ${N} 条 peer`)
  assert.equal(connects.length, N, `${N} 条 connect 各announce一次`)
  assert.equal(new Set(connects).size, N, 'peerId 各不相同')
  console.log(`    ${N} 条 tcp 连接建立: ${connMs.toFixed(0)}ms (${(connMs / N).toFixed(1)}ms/条)`)

  const [, downMs] = await timed(async () => { for (const c of clients) await c.stop() })
  await sleep(300)
  assert.equal(srv.nact.listPeerId().length, 0, '全部离表，一条不漏')
  console.log(`    ${N} 条断开: ${downMs.toFixed(0)}ms`)

  await stopSrv()
})

test('同一连接上 1000 条小消息串行往返', async () => {
  const spec = unix('edge-nact-burst')
  const { cli, stop } = await startPair(spec)
  const N = 1000

  const [, ms] = await timed(async () => {
    for (let i = 0; i < N; i++) {
      const res = await cli.request('srv', { kind: 'ability', target: 'add', payload: { a: i, b: 1 } })
      if (res.payload !== i + 1) assert.fail(`第 ${i} 条回来的是 ${res.payload}`)
    }
  })
  console.log(`    ${N} 条串行往返: ${ms.toFixed(0)}ms (${(ms / N).toFixed(2)}ms/条, ${(N / (ms / 1000)).toFixed(0)} req/s)`)
  await stop()
})

test('1000 条消息并发发出，全部回来且不串号', async () => {
  const spec = unix('edge-nact-conc')
  const { cli, stop } = await startPair(spec)
  const N = 1000

  const [results, ms] = await timed(() => Promise.all(
    Array.from({ length: N }, (_, i) => cli.request('srv', { kind: 'ability', target: 'add', payload: { a: i, b: 0 } })),
  ))
  // 每条的回值必须等于自己的入参 —— 这是「回包没串到别人的 pending」的直接证据
  assert.deepEqual(results.map(r => r.payload), Array.from({ length: N }, (_, i) => i))
  console.log(`    ${N} 条并发往返: ${ms.toFixed(0)}ms (${(N / (ms / 1000)).toFixed(0)} req/s)`)
  await stop()
})

// ── 超时路径（默认 skip：真等 30s+）──

test('重组超时：只发半个消息，30s 后报 reassembly-timeout', { skip: !SLOW }, async () => {
  // REASSEMBLY_TIMEOUT_MS = 30s。这条要真等，所以默认不跑。
  const errs = []
  const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
  reasm.ensure('half', 1000)
  reasm.advance('half', 0, 400)          // 剩下 600 永不到达
  const [, ms] = await timed(() => sleep(31_000))
  assert.deepEqual(errs, ['reassembly-timeout'], `等了 ${ms.toFixed(0)}ms`)
  console.log(`    reassembly-timeout 于 ${ms.toFixed(0)}ms 触发`)
})
