import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerWebSocketRuntime, workerWebSocketClient } from '../../../test/_kit.mjs'

test('普通 Worker 接受连接并完成 NApp Request / Response', { timeout: 30_000 }, async t => {
  const runtime = await workerWebSocketRuntime(t)
  const { client } = await workerWebSocketClient(t, runtime)
  assert.deepEqual(client.listConnectedApp(), ['worker'])
  const response = await client.request('worker', { kind: 'ability', target: 'echo', payload: 'hello' }).response
  assert.equal(response.payload, 'hello')
})
