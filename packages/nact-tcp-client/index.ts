import net from 'node:net'
import type { ClientTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

import { SocketChannel } from '@chenyfan/nact-channel/socket'

export interface TcpClientOptions {
  host: string
  port: number
  keepAlive?: number | false
}
export interface TcpClientTransportSpec {
  type: 'tcp'
  provider: TcpClientOptions
  nact?: { chunkSize?: number }
}

export default class TCPClientProvider implements ClientTransportProvider<'tcp', TcpClientOptions> {
  readonly type = 'tcp'
  readonly role = 'client'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async dial(options: TcpClientOptions): Promise<TransportChannel> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection({ host: options.host, port: options.port })
      candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate) })
      candidate.once('error', reject)
    })
    if (options.keepAlive !== false) socket.setKeepAlive(true, options.keepAlive ?? 30_000)
    return new SocketChannel(socket)
  }
}
