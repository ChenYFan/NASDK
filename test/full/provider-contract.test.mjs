import { test } from 'node:test'
import assert from 'node:assert/strict'
import TCPServer from '../../packages/nact-tcp-server/index.ts'
import TCPClient from '../../packages/nact-tcp-client/index.ts'
import UnixServer from '../../packages/nact-unix-server/index.ts'
import UnixClient from '../../packages/nact-unix-client/index.ts'
import WSServer from '../../packages/nact-websocket-server/index.ts'
import WSClient from '../../packages/nact-websocket-client/index.ts'

for (const [name, Server, Client, serverOptions, clientOptions] of [
  ['tcp', TCPServer, TCPClient, { host: '127.0.0.1', port: 19091 }, { host: '127.0.0.1', port: 19091 }],
  ['unix', UnixServer, UnixClient, { path: `/tmp/nasdk-contract-${process.pid}.sock` }, { path: `/tmp/nasdk-contract-${process.pid}.sock` }],
  ['websocket', WSServer, WSClient, { host: '127.0.0.1', port: 19092, path: '/nacp' }, { url: 'ws://127.0.0.1:19092/nacp' }],
]) {
  test(`${name} Provider: ordered bytes, iterator and callback exclusion, teardown`, async () => {
    let serverChannel
    const handle = await new Server().listen(serverOptions, channel => {
      serverChannel = channel
      channel.onError(() => {})
      channel.onReceive(bytes => { void Promise.resolve(channel.send([bytes])).catch(() => {}) })
    })
    const client = await new Client().dial(clientOptions)
    client.onError(() => {})
    try {
      const iterator = client[Symbol.asyncIterator]()
      assert.throws(() => client.onReceive(() => {}), { code: 'receive-mode-conflict' })
      const input = Uint8Array.from({ length: 65_536 }, (_, n) => n % 251)
      await client.send([input.subarray(0, 7), input.subarray(7)])
      const output = []
      while (output.length < input.length) output.push(...(await iterator.next()).value)
      assert.deepEqual(new Uint8Array(output), input)
      const closed = new Promise(resolve => client.onClose(resolve))
      await iterator.return()
      await closed
    } finally {
      client.terminate?.(); serverChannel?.terminate?.()
      await handle.close()
    }
  })
}
