import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import Server from '../../packages/nact-websocket-server/index.ts'
import Client from '../../packages/nact-websocket-client/index.ts'

test('WebSocket text frames fail iterator readers and release the channel', async () => {
  let channel, accepted
  const ready = new Promise(resolve => { accepted = resolve })
  const handle = await new Server().listen({ host: '127.0.0.1', port: 19093 }, c => { channel = c; accepted() })
  const socket = new WebSocket('ws://127.0.0.1:19093')
  try {
    await ready
    const pending = channel[Symbol.asyncIterator]().next()
    await new Promise(resolve => socket.readyState === WebSocket.OPEN ? resolve() : socket.once('open', resolve))
    socket.send('not binary')
    await assert.rejects(pending, { code: 'non-binary-frame' })
    assert.equal(channel.closed, true)
  } finally { socket.terminate(); channel?.terminate(); await handle.close() }
})

test('WebSocket client buffers early data and drains it before EOF', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 19094 })
  await new Promise(resolve => server.once('listening', resolve))
  server.on('connection', socket => { socket.send(new Uint8Array([1, 2, 3])); socket.close() })
  try {
    const channel = await new Client().dial({ url: 'ws://127.0.0.1:19094' })
    const received = []
    for await (const bytes of channel) received.push(...bytes)
    assert.deepEqual(received, [1, 2, 3])
  } finally { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)) }
})

test('WebSocket send bounds fail before queueing an oversized frame', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 19095 })
  await new Promise(resolve => server.once('listening', resolve))
  let channel
  try {
    channel = await new Client().dial({ url: 'ws://127.0.0.1:19095', maxBufferedBytes: 4 })
    assert.throws(() => channel.send([new Uint8Array(5)]), { code: 'send-buffer-overflow' })
  } finally { channel?.terminate(); for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)) }
})
