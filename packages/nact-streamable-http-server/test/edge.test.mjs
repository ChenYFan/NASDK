import { checkProviderDuplex, checkProviderBurst, checkProviderReconnect, frameOf } from '../../../test/_kit.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Core from '../handler.ts'
import Provider from '../index.ts'
import { NACT_PREFACE } from '../../nact-provider-shared/index.ts'
test('1 MiB 二进制双向交付逐字节一致', { timeout: 10000 }, t => checkProviderDuplex(t, import.meta.url, 1024 * 1024))
test('1000 帧连续提交，无丢帧或边界串接', { timeout: 10000 }, t => checkProviderBurst(t, import.meta.url))
test('20 次建立与关闭，监听入口仍可使用', { timeout: 10000 }, t => checkProviderReconnect(t, import.meta.url))

test('路由方法、鉴权与 POST 会话校验返回明确状态', async t => {
  const provider = new Core()
  const handle = await provider.listen({ port: 18987, authorize: request => request.headers.get('authorization') === 'allowed', idleTimeoutMs: 0 }, () => {})
  t.after(() => handle.close())
  for (const [method, headers, status] of [
    ['DELETE', {}, 405], ['GET', {}, 403], ['POST', { authorization: 'allowed' }, 404],
  ]) assert.equal((await provider.fetch(new Request('https://server.test/nacp', { method, headers }))).status, status)
  const response = await provider.fetch(new Request('https://server.test/nacp', { headers: { authorization: 'allowed' } }))
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  assert.deepEqual((await reader.read()).value, NACT_PREFACE)
  const token = response.headers.get('x-nact-session')
  const wrongType = await provider.fetch(new Request('https://server.test/nacp', { method: 'POST', headers: { authorization: 'allowed', 'x-nact-session': token } }))
  assert.equal(wrongType.status, 415)
  await reader.cancel()
})

test('会话、上传和下行缓冲超限均被拒绝', async t => {
  const provider = new Core()
  let channel
  const handle = await provider.listen({ port: 18987, idleTimeoutMs: 0, maxSessions: 1, maxBodyBytes: 1, maxBufferedBytes: 40 }, value => { channel = value })
  t.after(() => handle.close())
  const response = await provider.fetch(new Request('https://server.test/nacp'))
  assert.equal((await provider.fetch(new Request('https://server.test/nacp'))).status, 503)
  const uploaded = await provider.fetch(new Request('https://server.test/nacp', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-nact-session': response.headers.get('x-nact-session') }, body: new Uint8Array(2),
  }))
  assert.equal(uploaded.status, 413)
  await response.body.cancel()
  const second = await provider.fetch(new Request('https://server.test/nacp'))
  assert.throws(() => channel.send(frameOf(new Uint8Array(100))), error => error.code === 'send-buffer-overflow')
  assert.equal(channel.closed, true)
  await second.body.cancel()
})

test('noServer 由宿主路由，fetch 接受任意路径并检查关闭状态', async t => {
  const provider = new Provider()
  assert.equal((await provider.fetch(new Request('https://server.test/stream'))).status, 503)
  const handle = await provider.listen({ noServer: true, idleTimeoutMs: 0 }, () => {})
  t.after(() => handle.close())
  const other = await provider.fetch(new Request('https://server.test/other'))
  assert.equal(other.status, 200)
  await other.body.cancel()
  const response = await provider.fetch(new Request('https://server.test/stream'))
  const reader = response.body.getReader()
  assert.deepEqual((await reader.read()).value, NACT_PREFACE)
  await handle.close()
  assert.equal((await reader.read()).done, true)
  assert.equal((await provider.fetch(new Request('https://server.test/stream'))).status, 503)
})

test('POST 未读完时关闭 Provider：排空宿主流，不取消或交付后续数据', async t => {
  const provider = new Core()
  let channel
  const handle = await provider.listen({ noServer: true, idleTimeoutMs: 0 }, value => { channel = value })
  t.after(() => handle.close())
  const response = await provider.fetch(new Request('https://server.test/http'))
  let received = 0
  channel.onReceive(() => received++)
  let controller
  let cancelled = false
  const body = new ReadableStream({
    start(value) { controller = value },
    cancel() { cancelled = true },
  })
  const upload = provider.fetch(new Request('https://server.test/http', {
    method: 'POST', duplex: 'half', body,
    headers: { 'content-type': 'application/octet-stream', 'x-nact-session': response.headers.get('x-nact-session') },
  }))
  await handle.close()
  assert.equal(cancelled, false)
  controller.enqueue(new Uint8Array(NACT_PREFACE))
  controller.enqueue(new Uint8Array([0, 0, 0, 1, 42]))
  controller.close()
  assert.equal((await upload).status, 204)
  assert.equal(received, 0)
  await response.body.cancel()
})
