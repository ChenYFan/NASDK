// NACT framing + codec via fake sockets; real carriers are covered in simple/napp.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cborCodec } from '../../NACT/codec.ts'
import NApp from '../../index.ts'
import {
  FRAME_HEADER_SIZE, MAX_FRAME_SIZE, DEFAULT_CHUNK,
  checkFrameHeader, makeReassembler, makeFrameReceiver, splitAndEmit, toHex,
} from '../../NACT/framing.ts'
import { makeFrameSplitter } from '../../packages/nact-provider-shared/index.ts'

const aMessage = (payload) => ({
  v: { major: 1, minor: 0 }, type: 'notify', id: 'm1', from: 'a', to: 'b', t: 1,
  meta: { parentId: 'p', targetSubName: 'x', hitSubName: 'x' }, payload,
})

test('Provider：未注册和重复注册会明确失败', async () => {
  const app = new NApp({ id: 'provider-errors' })
  await app.start()
  await assert.rejects(
    app.nact.dial({ type: 'missing', provider: {} }),
    error => error.code === 'provider-not-found',
  )

  assert.doesNotThrow(
    () => app.nact.use({ type: 'memory', role: 'server', defaultChunkSize: 1024, listen: async () => ({ close: async () => {} }) }),
  )
  assert.throws(
    () => app.nact.use({ type: 'memory', role: 'server', defaultChunkSize: 1024, listen: async () => ({ close: async () => {} }) }),
    error => error.code === 'provider-already-registered',
  )
  await app.terminate()
})

/** Fake channel: records handlers so tests can trigger errors/close manually. */
function fakeChannel() {
  const on = { receive: [], close: [], error: [] }
  return {
    on,
    send() {},
    onReceive: (h) => { on.receive.push(h); return () => {} },
    onClose: (h) => { on.close.push(h); return () => {} },
    onError: (h) => { on.error.push(h); return () => {} },
    close() { for (const h of on.close) h() },
  }
}

test('Provider 在 listen / dial 里出的错，都包装成 NACTError，保留原 code 和 cause', async () => {
  const app = new NApp({ id: 'wrap-errors' })
  await app.start()
  const busy = Object.assign(new Error('port in use'), { code: 'EADDRINUSE' })
  app.nact.use({ type: 'busy', role: 'server', defaultChunkSize: 1024, listen: async () => { throw busy } })
  app.nact.use({ type: 'plain', role: 'server', defaultChunkSize: 1024, listen: () => { throw new Error('no code') } })
  app.nact.use({ type: 'busy', role: 'client', defaultChunkSize: 1024, dial: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) } })
  app.nact.use({ type: 'plain', role: 'client', defaultChunkSize: 1024, dial: async () => { throw 'bare string' } })

  const isNACT = (code, phase, cause) => (e) => {
    assert.equal(e.name, 'NACTError')
    assert.equal(e.layer, 'NACT')
    assert.equal(e.phase, phase)
    assert.equal(e.code, code)
    if (cause) assert.equal(e.cause, cause)
    return true
  }
  await assert.rejects(app.nact.listen({ type: 'busy', provider: {} }), isNACT('EADDRINUSE', 'internal', busy))
  await assert.rejects(app.nact.listen({ type: 'plain', provider: {} }), isNACT('listen-failed', 'internal'), '同步抛出也要包装')
  await assert.rejects(app.nact.dial({ type: 'busy', provider: {} }), isNACT('ECONNREFUSED', 'internal'))
  await assert.rejects(app.nact.dial({ type: 'plain', provider: {} }), isNACT('bare string', 'internal'), '字符串就是 code')
  await assert.rejects(app.nact.dial({ type: 'missing', provider: {} }), isNACT('provider-not-found', 'internal'), 'NACT 自己的错误原样抛出')
  await app.terminate()
})

test('编码失败：send 抛 NACTError（outbound / encode-failed），不影响连接', async () => {
  const app = new NApp({ id: 'encode-errors' })
  await app.start()
  const channel = fakeChannel()
  app.nact.use({ type: 'fake', role: 'client', defaultChunkSize: 1024, dial: async () => channel })
  const peer = await app.nact.dial({ type: 'fake', provider: {} })

  const circular = {}
  circular.self = circular
  await assert.rejects(peer.send(aMessage({ circular })), (e) => {
    assert.equal(e.name, 'NACTError')
    assert.equal(e.phase, 'outbound')
    assert.equal(e.code, 'encode-failed')
    assert.ok(e.cause, '保留 cbor-x 的原始错误')
    return true
  })
  assert.ok(app.nact.getPeer(peer.id), '编码失败只是这条消息发不出去，连接还在')
  await app.terminate()
})

test('连接失败的原因：Provider 的 code 原样透出，没有 code 记为 transport-error', async () => {
  const app = new NApp({ id: 'peer-errors' })
  await app.start()
  const channels = []
  app.nact.use({ type: 'fake', role: 'client', defaultChunkSize: 1024, dial: async () => { const c = fakeChannel(); channels.push(c); return c } })
  const reasons = []
  app.bus.listen('nact:peer:error', ({ reason }) => reasons.push(reason))

  await app.nact.dial({ type: 'fake', provider: {} })
  await app.nact.dial({ type: 'fake', provider: {} })
  for (const h of channels[0].on.error) h(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
  for (const h of channels[1].on.error) h(new Error('browser ws error has no code'))

  assert.deepEqual(reasons, ['ECONNRESET', 'transport-error'])
  assert.equal(app.nact.listPeerId().length, 0, '出错后 NACT 关闭连接，Peer 离表')
  await app.terminate()
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

  // CBOR has a byte string type, so images/embeddings pass through as-is
  assert.deepEqual([...back.payload.blob], [...blob])
})

test('帧头：32 字节，自带长度，版本合法', () => {
  const bytes = cborCodec.encode(aMessage({ x: 1 }))
  const frames = []
  splitAndEmit(bytes, DEFAULT_CHUNK.tcp, (header, body) => frames.push({ header, body }))

  assert.equal(frames.length, 1, '小包只有一帧，但仍然带帧头')
  const { header, body } = frames[0]
  assert.equal(header.length, FRAME_HEADER_SIZE)
  assert.equal(checkFrameHeader(header), null, '头合法')

  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength)
  assert.equal(dv.getUint32(16), 0, 'offset')
  assert.equal(dv.getUint32(20), bytes.length, 'totalSize')
  assert.equal(dv.getUint32(24), FRAME_HEADER_SIZE + body.length, 'thisFrameSize = 头 + 体')
})

test('帧头坏了要认出来', () => {
  const bytes = cborCodec.encode(aMessage({ x: 1 }))
  let header
  splitAndEmit(bytes, DEFAULT_CHUNK.tcp, (h) => { header = h })

  const badMagic = Uint8Array.from(header); badMagic[30] = 0
  assert.equal(checkFrameHeader(badMagic), 'bad-magic')

  const badVersion = Uint8Array.from(header); badVersion[31] = 99
  assert.equal(checkFrameHeader(badVersion), 'version-mismatch')
})

test('大包分片成多帧，重组回原样', () => {
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
    reasm.ensure(id, dv.getUint32(20)).set(body, offset)   // single copy: frame body lands in place
    reasm.advance(id, offset, body.length)
  })

  assert.ok(count > 40, `分片成 ${count} 帧`)
  assert.deepEqual(got, msg, '重组 + 解码后一模一样')
})

test('同一个包的所有帧共享 msgId', () => {
  const bytes = cborCodec.encode(aMessage({ blob: 'z'.repeat(5000) }))
  const ids = new Set()
  splitAndEmit(bytes, 1024, (header) => ids.add(toHex(header.subarray(0, 16))))
  assert.equal(ids.size, 1)
})

test('重叠的帧是错的，要拒绝', () => {
  const errs = []
  const reasm = makeReassembler(() => {}, (r) => errs.push(r))
  reasm.ensure('id1', 100)
  reasm.advance('id1', 0, 50)
  reasm.advance('id1', 25, 50)      // overlaps previous frame
  assert.deepEqual(errs, ['overlapping-frame'])
})

test('越界的帧也要拒绝', () => {
  const errs = []
  const reasm = makeReassembler(() => {}, (r) => errs.push(r))
  reasm.ensure('id2', 100)
  reasm.advance('id2', 80, 50)      // 80+50 > 100
  assert.deepEqual(errs, ['frame-out-of-bounds'])
})

test('字节流切帧：socket 怎么切块，Provider 都能切回整帧交给 NACT', () => {
  const msg = aMessage({ blob: 'w'.repeat(3000) })
  const bytes = cborCodec.encode(msg)

  // wire format of tcp/unix is frames laid out contiguously as [header][body]
  const wire = []
  splitAndEmit(bytes, 512, (header, body) => { wire.push(header, body) })
  const total = wire.reduce((n, b) => n + b.length, 0)
  const stream = new Uint8Array(total)
  let at = 0
  for (const b of wire) { stream.set(b, at); at += b.length }

  // feed in differently sized chunks to mimic arbitrary socket segmentation
  for (const chunkSize of [1, 7, 512, 9999]) {
    let got = null
    const receiver = makeFrameReceiver((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
    const push = makeFrameSplitter((frame) => receiver.receive(frame), (e) => assert.fail(e.message))
    for (let i = 0; i < stream.length; i += chunkSize) push(stream.subarray(i, i + chunkSize))
    assert.deepEqual(got, msg, `按 ${chunkSize} 字节喂也能还原`)
  }
})

test('单帧包不经过重组：帧体直接交给解码', () => {
  const msg = aMessage({ n: 1 })
  let frame
  splitAndEmit(cborCodec.encode(msg), 1024, (header, body) => { frame = [header, body] })
  let got
  makeFrameReceiver((full) => { got = full }, (r) => assert.fail(r)).receive(frame)
  assert.equal(got, frame[1], '零拷贝')
  assert.deepEqual(cborCodec.decode(got), msg)
})

test('空包也发一帧，接收侧没有特例', () => {
  const frames = []
  splitAndEmit(new Uint8Array(0), 1024, (header, body) => frames.push({ header, body }))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].body.length, 0)
  assert.equal(checkFrameHeader(frames[0].header), null)
})

test('帧上限是 2GiB —— 防的是失控的长度字段，不是物理限制', () => {
  assert.equal(MAX_FRAME_SIZE, 2 * 1024 * 1024 * 1024)
})
