import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import Provider from '../index.ts'
import { checkProviderDuplex, checkProviderBurst, checkProviderReconnect } from '../../../test/_kit.mjs'
test('1 MiB 二进制双向交付逐字节一致', { timeout: 10000 }, t => checkProviderDuplex(t, import.meta.url, 1024 * 1024))
test('1000 帧连续提交，无丢帧或边界串接', { timeout: 10000 }, t => checkProviderBurst(t, import.meta.url))
test('20 次建立与关闭，监听入口仍可使用', { timeout: 10000 }, t => checkProviderReconnect(t, import.meta.url))

test('附着宿主：路径隔离、双向交付、关闭连接但保留宿主', { timeout: 10000 }, async t => {
  const server = http.createServer((_request, response) => response.end('host'))
  const other = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/other') other.handleUpgrade(request, socket, head, ws => other.emit('connection', ws))
  })
  t.after(() => {
    for (const socket of other.clients) socket.terminate()
    other.close()
    server.closeAllConnections()
    server.close()
  })
  const provider = new Provider()
  assert.throws(() => provider.attach(server), error => error.code === 'provider-not-listening')
  const handle = await provider.listen({ noServer: true }, channel => {
    channel.onReceive(frame => channel.send(frame))
  })
  t.after(() => handle.close())
  const detach = provider.attach(server, { path: '/unused' })
  detach()
  detach()
  provider.attach(server, { path: '/nacp' })
  assert.equal(server.listening, false)
  assert.equal(server.listenerCount('upgrade'), 2)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const socket = new WebSocket(url.replace('http', 'ws') + '/nacp')
  t.after(() => socket.terminate())
  await once(socket, 'open')
  const received = once(socket, 'message')
  socket.send(Buffer.from([0, 1, 128, 255]))
  assert.deepEqual((await received)[0], Buffer.from([0, 1, 128, 255]))
  const otherSocket = new WebSocket(url.replace('http', 'ws') + '/other')
  t.after(() => otherSocket.terminate())
  await once(otherSocket, 'open')
  const closed = once(socket, 'close')
  await Promise.all([handle.close(), handle.close()])
  await closed
  assert.throws(() => provider.attach(server), error => error.code === 'provider-not-listening')
  assert.equal(server.listening, true)
  assert.equal(server.listenerCount('upgrade'), 1)
  assert.equal(otherSocket.readyState, WebSocket.OPEN)
  assert.equal(await (await fetch(url)).text(), 'host')
})
