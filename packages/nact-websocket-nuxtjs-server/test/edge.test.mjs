import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import Provider from '../index.ts'
import { fixture } from './_kit.mjs'

test('1 MiB、1000 帧和重连保持数据与边界', { timeout: 10000 }, async t => {
  const { connect } = await fixture(t)
  for (let i = 0; i < 3; i++) {
    const socket = await connect()
    const bytes = Buffer.alloc(i === 0 ? 1024 * 1024 : 16, i)
    const received = once(socket, 'message')
    socket.send(bytes)
    assert.deepEqual((await received)[0], bytes)
    if (i === 0) {
      let count = 0
      const done = new Promise((resolve, reject) => socket.on('message', data => {
        try { assert.equal(data.readUInt32BE(), count++); if (count === 1000) resolve() } catch (reason) { reject(reason) }
      }))
      for (let n = 0; n < 1000; n++) { const frame = Buffer.alloc(4); frame.writeUInt32BE(n); socket.send(frame) }
      await done
    }
    const closed = once(socket, 'close')
    socket.close()
    await closed
  }
})

test('鉴权与生命周期：未启动、拒绝、鉴权中关闭、旧握手不进入新实例', async () => {
  const provider = new Provider()
  const request = () => ({ url: 'http://test/ws', headers: new Headers(), context: {} })
  assert.equal((await provider.hooks.upgrade(request())).status, 503)
  let release
  const handle = await provider.listen({ authorize: () => new Promise(resolve => { release = resolve }) }, () => {})
  await assert.rejects(provider.listen({}, () => {}), error => error.code === 'provider-already-listening')
  const pending = provider.hooks.upgrade(request())
  await handle.close()
  release(true)
  assert.equal((await pending).status, 503)
  const denied = await provider.listen({ authorize: () => false }, () => {})
  assert.equal((await provider.hooks.upgrade(request())).status, 403)
  await denied.close()
  let accepted = 0
  const old = await provider.listen({}, () => accepted++)
  const handshake = request()
  await provider.hooks.upgrade(handshake)
  await old.close()
  const current = await provider.listen({}, () => accepted++)
  let terminated = false
  provider.hooks.open({ context: handshake.context, terminate() { terminated = true } })
  assert.equal(terminated, true)
  assert.equal(accepted, 0)
  await current.close()
})
