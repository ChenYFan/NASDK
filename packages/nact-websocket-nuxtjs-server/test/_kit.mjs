import http from 'node:http'
import { once } from 'node:events'
import nodeAdapter from 'crossws/adapters/node'
import { WebSocket } from 'ws'
import Provider from '../index.ts'

export async function fixture(t, options = {}, accept = channel => channel.onReceive(frame => channel.send(frame))) {
  const provider = new Provider()
  const handle = await provider.listen(options, accept)
  const server = http.createServer((_req, res) => res.end('host'))
  const adapter = nodeAdapter({ hooks: provider.hooks })
  server.on('upgrade', (req, socket, head) => { void adapter.handleUpgrade(req, socket, head) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await handle.close()
    adapter.closeAll(1000, '', true)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  async function connect() {
    const socket = new WebSocket(url.replace('http', 'ws') + '/ws')
    t.after(() => socket.terminate())
    await once(socket, 'open')
    return socket
  }
  return { provider, handle, server, adapter, url, connect }
}
