import net from 'node:net'
import type { ServerHandle, ServerTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

import { SocketChannel } from '@chenyfan/nact-channel/socket'

export interface TcpServerOptions {
  host: string
  port: number
  keepAlive?: number | false
}
export interface TcpServerTransportSpec {
  type: 'tcp'
  provider: TcpServerOptions
  nact?: { chunkSize?: number }
}

export default class TCPServerProvider implements ServerTransportProvider<'tcp', TcpServerOptions> {
  readonly type = 'tcp'
  readonly role = 'server'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async listen(options: TcpServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    const server = net.createServer((socket) => {
      if (options.keepAlive !== false) socket.setKeepAlive(true, options.keepAlive ?? 30_000)
      accept(new SocketChannel(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: options.host, port: options.port }, () => { server.off('error', reject); resolve() })
    })
    return { close: () => new Promise(resolve => server.close(() => resolve())) }
  }
}
