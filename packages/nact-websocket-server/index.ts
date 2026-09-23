import http from 'node:http'
import { WebSocketServer } from 'ws'
import type { ServerHandle, ServerTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

import { webSocketChannel, type WebSocketLike } from '@chenyfan/nact-channel/websocket'

export interface WebSocketServerOptions {
  host: string
  port: number
  path?: string
  maxBufferedBytes?: number
}
export interface WebSocketServerTransportSpec {
  type: 'websocket'
  provider: WebSocketServerOptions
  nact?: { chunkSize?: number }
}

export default class WebSocketServerProvider
  implements ServerTransportProvider<'websocket', WebSocketServerOptions> {
  readonly type = 'websocket'
  readonly role = 'server'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async listen(options: WebSocketServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    const server = http.createServer()
    const websocket = new WebSocketServer({ server, path: options.path, perMessageDeflate: false })
    websocket.on('connection', socket => accept(webSocketChannel(socket as unknown as WebSocketLike, options.maxBufferedBytes ?? 128 * 1024 * 1024)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => { server.off('error', reject); resolve() })
    })
    return {
      close: () => new Promise(resolve => websocket.close(() => server.close(() => resolve()))),
    }
  }
}
