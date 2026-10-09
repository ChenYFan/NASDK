import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerWebSocketRuntime, workerWebSocketClient, waitFor } from '../../../test/_kit.mjs'

test('Worker 多帧二进制往返与同连接并发 Request', { timeout: 30_000 }, async t => {
  const runtime = await workerWebSocketRuntime(t)
  const { client } = await workerWebSocketClient(t, runtime)
  const payload = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => i % 251)
  const response = await client.request('worker', { kind: 'ability', target: 'echo', payload }).response
  assert.deepEqual(response.payload, payload)
  const responses = await Promise.all(Array.from({ length: 100 }, () =>
    client.request('worker', { kind: 'ability', target: 'counter' }).response))
  assert.deepEqual(responses.map(response => response.payload).sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, i) => i + 1))
})

test('文本消息拒绝后断开连接', { timeout: 30_000 }, async t => {
  const runtime = await workerWebSocketRuntime(t)
  const { client, socket } = await workerWebSocketClient(t, runtime)
  const disconnected = waitFor(client.bus, 'nact:peer:disconnect')
  socket.send('not a NACT frame')
  await disconnected
  assert.deepEqual(client.listConnectedApp(), [])
})
