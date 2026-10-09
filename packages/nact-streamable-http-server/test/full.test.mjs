import { checkProviderFrames, checkProviderClose } from '../../../test/_kit.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Server from '../index.ts'
test('多段帧、空帧和连续帧保持字节与边界', { timeout: 5000 }, t => checkProviderFrames(t, import.meta.url))
test('关闭通知只触发一次，关闭后拒绝发送', { timeout: 5000 }, t => checkProviderClose(t, import.meta.url))

test('StreamableHTTP Server Provider：port 必选，缺失时 listen 失败且不占用 Provider', async t => {
  const provider = new Server()
  const invalidPort = error => error.code === 'invalid-port'
  await assert.rejects(provider.listen({}, () => {}), invalidPort, '不给 port')
  await assert.rejects(provider.listen({ host: '127.0.0.1' }, () => {}), invalidPort, '只给 host')
  const handle = await provider.listen({ port: 18987, idleTimeoutMs: 0 }, () => {})
  t.after(() => handle.close())
})
