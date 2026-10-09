import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFrameSplitter, NACT_PREFACE } from '../index.ts'
import { frameOf } from '../../../test/_kit.mjs'

test('完整帧原样切出，前导为 version + magic', () => {
  const wire = Buffer.concat(frameOf(new Uint8Array([1, 2, 3])))
  const received = []
  makeFrameSplitter(frame => received.push(Buffer.concat(frame)), assert.fail)(wire)
  assert.deepEqual(received, [wire])
  assert.deepEqual([...NACT_PREFACE], [0x01, 0xcf])
})
