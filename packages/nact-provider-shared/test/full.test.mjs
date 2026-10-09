import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFrameSplitter, readFrameSize, FRAME_HEADER_SIZE } from '../index.ts'
import { frameOf } from '../../../test/_kit.mjs'

test('任意分块切回完整帧，整帧路径保留原内存', () => {
  const frames = [frameOf(new Uint8Array()), frameOf(new Uint8Array(3000)), frameOf(new Uint8Array([9]))].map(frame => Buffer.concat(frame))
  const wire = Buffer.concat(frames)
  for (const size of [1, 7, 31, 32, 33, 512, wire.length]) {
    const out = []
    const push = makeFrameSplitter(frame => {
      if (size === wire.length) assert.equal(frame[0].buffer, wire.buffer)
      out.push(Buffer.concat(frame))
    }, assert.fail)
    for (let at = 0; at < wire.length; at += size) push(wire.subarray(at, at + size))
    assert.deepEqual(out, frames)
  }
})

test('版本、magic 与长度校验按顺序失败，损坏后不再交付', () => {
  const [header] = frameOf(new Uint8Array())
  assert.equal(readFrameSize(header), FRAME_HEADER_SIZE)
  for (const [change, code] of [
    [bytes => { bytes[31] = 99; bytes[30] = 0 }, 'version-mismatch'],
    [bytes => { bytes[30] = 0 }, 'bad-magic'],
    [bytes => new DataView(bytes.buffer, bytes.byteOffset).setUint32(24, 31), 'frame-too-small'],
  ]) {
    const bad = header.slice()
    change(bad)
    const errors = []
    const push = makeFrameSplitter(() => assert.fail('损坏之后不能再交付'), error => errors.push(error.code))
    push(bad)
    push(header)
    assert.deepEqual(errors, [code])
  }
})
