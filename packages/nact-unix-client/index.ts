import net from 'node:net'
import type { ClientTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

import { SocketChannel } from '@chenyfan/nact-channel/socket'

export interface UnixClientOptions { path: string }
export interface UnixClientTransportSpec {
  type: 'unix'
  provider: UnixClientOptions
  nact?: { chunkSize?: number }
}

export default class UnixClientProvider implements ClientTransportProvider<'unix', UnixClientOptions> {
  readonly type = 'unix'
  readonly role = 'client'
  readonly defaultChunkSize = 2 * 1024 * 1024 * 1024

  async dial(options: UnixClientOptions): Promise<TransportChannel> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection(options.path)
      candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate) })
      candidate.once('error', reject)
    })
    return new SocketChannel(socket)
  }
}
