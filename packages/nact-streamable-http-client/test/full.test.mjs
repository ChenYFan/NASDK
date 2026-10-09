import { checkProviderFrames, checkProviderClose, httpChannel } from '../../../test/_kit.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as flush } from 'node:timers/promises'
test('多段帧、空帧和连续帧保持字节与边界', { timeout: 5000 }, t => checkProviderFrames(t, import.meta.url))
test('关闭通知只触发一次，关闭后拒绝发送', { timeout: 5000 }, t => checkProviderClose(t, import.meta.url))

test('HTTP Provider 入队即接纳，POST 仍串行执行；后续失败走 onError', async t => {
  const { channel, posts } = await httpChannel(t)
  const reasons = []
  channel.onError(reason => reasons.push(reason.code))
  await channel.send([new Uint8Array([1])])
  await channel.send([new Uint8Array([2])])
  await channel.send([new Uint8Array([3])])
  assert.equal(posts.length, 1, '接纳后三条帧，首个 POST 仍未完成')
  posts[0].resolve(new Response(null, { status: 204 }))
  await flush()
  assert.equal(posts.length, 2)
  posts[1].resolve(new Response(null, { status: 500 }))
  await flush()
  assert.deepEqual(reasons, ['http-post-500'])
  assert.equal(posts.length, 2, '失败后不再发送队列中的下一帧')
  assert.equal(channel.closed, true)
})
