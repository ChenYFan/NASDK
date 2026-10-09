import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFrameSplitter, readFrameSize, MAX_FRAME_SIZE } from '../index.ts'
import { frameOf } from '../../../test/_kit.mjs'

test('1000 帧合并与单字节输入均不丢帧', () => {
  const frames = Array.from({ length: 1000 }, (_, i) => Buffer.concat(frameOf(new Uint8Array([i & 255]))))
  const wire = Buffer.concat(frames)
  for (const size of [1, wire.length]) {
    const received = []
    const push = makeFrameSplitter(frame => received.push(Buffer.concat(frame)), assert.fail)
    for (let at = 0; at < wire.length; at += size) push(wire.subarray(at, at + size))
    assert.deepEqual(received, frames)
  }
})

test('超长帧与不完整帧头的边界明确拒绝', () => {
  const [header] = frameOf(new Uint8Array())
  new DataView(header.buffer, header.byteOffset).setUint32(24, MAX_FRAME_SIZE + 1)
  assert.throws(() => readFrameSize(header), error => error.code === 'frame-too-large')
  assert.throws(() => readFrameSize(header.subarray(0, 31)), error => error.code === 'frame-too-small')
})
