import type { ClientTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

import { webSocketChannel, type WebSocketLike } from '@chenyfan/nact-channel/websocket'

export interface WebSocketClientOptions { url: string; maxBufferedBytes?: number }
export interface WebSocketClientTransportSpec {
  type: 'websocket'
  provider: WebSocketClientOptions
  nact?: { chunkSize?: number }
}

export default class WebSocketClientProvider
  implements ClientTransportProvider<'websocket', WebSocketClientOptions> {
  readonly type = 'websocket'
  readonly role = 'client'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async dial(options: WebSocketClientOptions): Promise<TransportChannel> {
    const Constructor = typeof WebSocket === 'undefined'
      ? (await import('ws')).default
      : WebSocket
    const socket = new Constructor(options.url) as unknown as WebSocketLike
    socket.binaryType = 'arraybuffer'
    // Attach before awaiting open: a server may send and close in the same network turn.
    const channel = webSocketChannel(socket, options.maxBufferedBytes ?? 128 * 1024 * 1024)
    await new Promise<void>((resolve, reject) => {
      const open = () => { cleanup(); resolve() }
      const error = (reason: unknown) => { cleanup(); reject(reason) }
      const closed = () => error(new Error('WebSocket closed before open'))
      const cleanup = () => {
        socket.removeEventListener('open', open)
        socket.removeEventListener('error', error)
        socket.removeEventListener('close', closed)
      }
      socket.addEventListener('open', open)
      socket.addEventListener('error', error)
      socket.addEventListener('close', closed)
    })
    return channel
  }
}
