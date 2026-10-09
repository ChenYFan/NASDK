import { test } from 'node:test'
import assert from 'node:assert/strict'
import Provider from '../index.ts'
import { checkProviderDuplex, checkProviderBurst, checkProviderReconnect } from '../../../test/_kit.mjs'
test('1 MiB 二进制双向交付逐字节一致', { timeout: 10000 }, t => checkProviderDuplex(t, import.meta.url, 1024 * 1024))
test('1000 帧连续提交，无丢帧或边界串接', { timeout: 10000 }, t => checkProviderBurst(t, import.meta.url))
test('20 次建立与关闭，监听入口仍可使用', { timeout: 10000 }, t => checkProviderReconnect(t, import.meta.url))
test('占用端口拒绝监听，关闭后端口可复用', async t => {
  const options = { host: '127.0.0.1', port: 18989 }
  const first = await new Provider().listen(options, () => {})
  t.after(() => first.close())
  await assert.rejects(new Provider().listen(options, () => {}), error => error.code === 'EADDRINUSE')
  await first.close()
  const next = await new Provider().listen(options, () => {})
  await next.close()
})
