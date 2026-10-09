import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fixture } from './_kit.mjs'

test('CrossWS 路由接受连接并交付二进制帧', async t => {
  const { connect } = await fixture(t)
  const socket = await connect()
  const received = once(socket, 'message')
  socket.send(Buffer.from([0, 1, 128, 255]))
  const [bytes, binary] = await received
  assert.equal(binary, true)
  assert.deepEqual(bytes, Buffer.from([0, 1, 128, 255]))
})
