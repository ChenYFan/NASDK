import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { fixture } from './_kit.mjs'

test('多段帧主动发送、关闭通知一次、关闭后拒绝发送并保留宿主', async t => {
  let channel
  const { handle, server, url, connect } = await fixture(t, {}, value => { channel = value })
  const socket = await connect()
  let closes = 0
  channel.onClose(() => closes++)
  const received = once(socket, 'message')
  channel.send([new Uint8Array([0, 1]), new Uint8Array([128, 255])])
  assert.deepEqual((await received)[0], Buffer.from([0, 1, 128, 255]))
  const closed = once(socket, 'close')
  await Promise.all([handle.close(), handle.close()])
  await closed
  assert.equal(closes, 1)
  assert.throws(() => channel.send([]), error => error.code === 'transport-closed')
  assert.equal(server.listening, true)
  assert.equal(await (await fetch(url)).text(), 'host')
})

test('文本帧被拒绝并触发错误与关闭', async t => {
  let reason
  const { provider, adapter, connect } = await fixture(t, {}, channel => channel.onError(value => { reason = value }))
  const socket = await connect()
  const closed = once(socket, 'close')
  provider.hooks.message([...adapter.peers][0], { rawData: 'text' })
  await closed
  assert.equal(reason.code, 'non-binary-frame')
})
