import { test } from 'node:test'
import assert from 'node:assert/strict'
import Provider from '../index.ts'
import { workerWebSocketRuntime, workerWebSocketClient, sleep, deferred } from '../../../test/_kit.mjs'

test('fetch 返回以后，同一连接的 NApp 和业务内存状态持续有效', { timeout: 30_000 }, async t => {
  const runtime = await workerWebSocketRuntime(t)
  const { client } = await workerWebSocketClient(t, runtime)
  for (let count = 1; count <= 5; count++) {
    await sleep(50)
    const response = await client.request('worker', { kind: 'ability', target: 'counter' }).response
    assert.equal(response.payload, count)
  }
  await client.disconnect('worker')
  assert.deepEqual(client.listConnectedApp(), [])
})

test('路由、Upgrade、方法和鉴权在建立连接前处理', { timeout: 30_000 }, async t => {
  const runtime = await workerWebSocketRuntime(t)
  const get = (path, init) => runtime.dispatchFetch(`https://worker.test${path}`, init)
  assert.equal((await get('/other')).status, 404)
  assert.equal((await get('/nacp')).status, 426)
  assert.equal((await get('/nacp', { method: 'POST' })).status, 405)
  assert.equal((await get('/nacp?deny', { headers: { Upgrade: 'websocket' } })).status, 403)
})

test('关闭监听期间，尚未完成的鉴权不能建立连接', async () => {
  const provider = new Provider()
  const gate = deferred()
  assert.equal((await provider.fetch(new Request('https://worker.test/nacp'))).status, 503)
  const handle = await provider.listen({ authorize: () => gate.promise }, assert.fail)
  await assert.rejects(provider.listen({}, assert.fail), error => error.code === 'provider-already-listening')
  const response = provider.fetch(new Request('https://worker.test/nacp', { headers: { Upgrade: 'websocket' } }))
  await handle.close()
  gate.resolve(true)
  assert.equal((await response).status, 503)
})
