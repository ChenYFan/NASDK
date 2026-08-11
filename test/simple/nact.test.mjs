/**
 * simple/nact — 传输层自己的机制：一条消息怎么变成字节、切成片、再拼回来。
 *
 * 不起 socket。NACT 的核心（framing + codec）是纯函数，Peer 工厂只要一个假 socket 就能造。
 * 三种 carrier 的实际连通在 simple/napp 里跑（那里起真进程）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cborCodec } from '../../NACT/codec.ts'
import {
  FRAG_HEADER, MAX_FRAME_SIZE, DEFAULT_CHUNK,
  checkFragHeader, makeReassembler, makeStreamParser, splitAndEmit, toHex,
} from '../../NACT/framing.ts'

const aMessage = (payload) => ({
  v: { major: 1, minor: 0 }, type: 'notify', id: 'm1', from: 'a', to: 'b', t: 1,
  meta: { parentId: 'p', targetSubName: 'x', hitSubName: 'x' }, payload,
})

test('codec：对象 → 字节 → 对象，原样回来', () => {
  const msg = aMessage({ text: '中文', n: 42, flag: true, nested: { arr: [1, 2, 3] } })
  const bytes = cborCodec.encode(msg)

  assert.ok(bytes instanceof Uint8Array)
  assert.deepEqual(cborCodec.decode(bytes), msg)
})

test('codec：二进制直接走，不转 base64', () => {
  const blob = new Uint8Array([0, 1, 2, 253, 254, 255])
  const back = cborCodec.decode(cborCodec.encode(aMessage({ blob })))

  // CBOR 有字节串类型，所以图片/embedding 这类东西是原样过去的
  assert.deepEqual([...back.payload.blob], [...blob])
})

test('分片头：32 字节，自带长度，版本合法', () => {
  const bytes = cborCodec.encode(aMessage({ x: 1 }))
  const frames = []
  splitAndEmit(bytes, DEFAULT_CHUNK.tcp, (header, body) => frames.push({ header, body }))

  assert.equal(frames.length, 1, '小消息只有一片，但仍然带头')
  const { header, body } = frames[0]
  assert.equal(header.length, FRAG_HEADER)
  assert.equal(checkFragHeader(header), null, '头合法')

  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength)
  assert.equal(dv.getUint32(16), 0, 'offset')
  assert.equal(dv.getUint32(20), bytes.length, 'totalSize')
  assert.equal(dv.getUint32(24), FRAG_HEADER + body.length, 'thisFrameSize = 头 + 体')
})

test('分片头坏了要认出来', () => {
  const bytes = cborCodec.encode(aMessage({ x: 1 }))
  let header
  splitAndEmit(bytes, DEFAULT_CHUNK.tcp, (h) => { header = h })

  const badMagic = Uint8Array.from(header); badMagic[30] = 0
  assert.equal(checkFragHeader(badMagic), 'bad-magic')

  const badVersion = Uint8Array.from(header); badVersion[31] = 99
  assert.equal(checkFragHeader(badVersion), 'version-mismatch')
})

test('大消息切多片，重组回原样', () => {
  const msg = aMessage({ blob: 'y'.repeat(50 * 1024) })
  const bytes = cborCodec.encode(msg)

  let got = null
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))

  let count = 0
  splitAndEmit(bytes, 1024, (header, body) => {
    count++
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const id = toHex(header.subarray(0, 16))
    const offset = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(body, offset)   // 单次拷贝：片体直接落到目标位置
    reasm.advance(id, offset, body.length)
  })

  assert.ok(count > 40, `切了 ${count} 片`)
  assert.deepEqual(got, msg, '重组 + 解码后一模一样')
})

test('同一条消息的所有片共享 msgId', () => {
  const bytes = cborCodec.encode(aMessage({ blob: 'z'.repeat(5000) }))
  const ids = new Set()
  splitAndEmit(bytes, 1024, (header) => ids.add(toHex(header.subarray(0, 16))))
  assert.equal(ids.size, 1)
})

test('重叠的片是错的，要拒绝', () => {
  const errs = []
  const reasm = makeReassembler(() => {}, (r) => errs.push(r))
  reasm.ensure('id1', 100)
  reasm.advance('id1', 0, 50)
  reasm.advance('id1', 25, 50)      // 和上一片重叠
  assert.deepEqual(errs, ['overlapping-fragment'])
})

test('越界的片也要拒绝', () => {
  const errs = []
  const reasm = makeReassembler(() => {}, (r) => errs.push(r))
  reasm.ensure('id2', 100)
  reasm.advance('id2', 80, 50)      // 80+50 > 100
  assert.deepEqual(errs, ['fragment-out-of-bounds'])
})

test('裸流解析：socket 怎么切块都能还原', () => {
  const msg = aMessage({ blob: 'w'.repeat(3000) })
  const bytes = cborCodec.encode(msg)

  // 先把完整线上字节拼出来（tcp/unix 的线格式就是 [头][体] 连续排列）
  const wire = []
  splitAndEmit(bytes, 512, (header, body) => { wire.push(header, body) })
  const total = wire.reduce((n, b) => n + b.length, 0)
  const stream = new Uint8Array(total)
  let at = 0
  for (const b of wire) { stream.set(b, at); at += b.length }

  // 然后按不同大小的块喂进去 —— 模拟 socket 的任意分块
  for (const chunkSize of [1, 7, 512, 9999]) {
    let got = null
    const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
    const parse = makeStreamParser(reasm)
    for (let i = 0; i < stream.length; i += chunkSize) parse(stream.subarray(i, i + chunkSize))
    assert.deepEqual(got, msg, `按 ${chunkSize} 字节喂也能还原`)
  }
})

test('空消息也发一片，接收侧没有特例', () => {
  const frames = []
  splitAndEmit(new Uint8Array(0), 1024, (header, body) => frames.push({ header, body }))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].body.length, 0)
  assert.equal(checkFragHeader(frames[0].header), null)
})

test('帧上限是 2GiB —— 防的是失控的长度字段，不是物理限制', () => {
  assert.equal(MAX_FRAME_SIZE, 2 * 1024 * 1024 * 1024)
})
