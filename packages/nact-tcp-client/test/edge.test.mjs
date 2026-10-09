import { test } from 'node:test'
import assert from 'node:assert/strict'
import Provider from '../index.ts'
import { checkProviderDuplex, checkProviderBurst, checkProviderReconnect } from '../../../test/_kit.mjs'
test('1 MiB 二进制双向交付逐字节一致', { timeout: 10000 }, t => checkProviderDuplex(t, import.meta.url, 1024 * 1024))
test('1000 帧连续提交，无丢帧或边界串接', { timeout: 10000 }, t => checkProviderBurst(t, import.meta.url))
test('20 次建立与关闭，监听入口仍可使用', { timeout: 10000 }, t => checkProviderReconnect(t, import.meta.url))
test('无人监听时 dial 明确拒绝', async () => {
  await assert.rejects(new Provider().dial({ host: '127.0.0.1', port: 18989 }), error => error.code === 'ECONNREFUSED')
})
