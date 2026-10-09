import { checkProviderDuplex, checkProviderBurst, checkProviderReconnect, httpChannel, deferred } from '../../../test/_kit.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Client from '../index.ts'
test('1 MiB 二进制双向交付逐字节一致', { timeout: 10000 }, t => checkProviderDuplex(t, import.meta.url, 1024 * 1024))
test('1000 帧连续提交，无丢帧或边界串接', { timeout: 10000 }, t => checkProviderBurst(t, import.meta.url))
test('20 次建立与关闭，监听入口仍可使用', { timeout: 10000 }, t => checkProviderReconnect(t, import.meta.url))

test('HTTP Provider 缓冲上限拒绝接纳，关闭后也不能再报告成功', async t => {
  const { channel } = await httpChannel(t, { maxBufferedBytes: 2 })
  const reasons = []
  channel.onError(reason => reasons.push(reason.code))
  channel.send([new Uint8Array(2)])
  assert.throws(() => channel.send([new Uint8Array(1)]), error => error.code === 'send-buffer-overflow')
  assert.throws(() => channel.send([new Uint8Array(1)]), error => error.code === 'transport-closed')
  assert.deepEqual(reasons, ['send-buffer-overflow'])
})

test('下行前导逐字节校验，错误或缺失前导拒绝连接', async () => {
  for (const bytes of [[1, 0xcf], [1, 0], [1]]) {
    const closed = deferred()
    const reasons = []
    const channel = await new Client().dial({ url: 'https://provider.test/nacp', fetch: async () =>
      new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      } }), { headers: { 'content-type': 'application/octet-stream', 'x-nact-session': 's' } }) })
    channel.onError(reason => reasons.push(reason.code))
    channel.onClose(closed.resolve)
    await closed.promise
    assert.deepEqual(reasons, bytes.length === 2 && bytes[1] === 0xcf ? [] : ['invalid-http-preface'])
  }
})
