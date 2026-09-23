import net from 'node:net'
import type { ServerHandle, ServerTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

import { SocketChannel } from '@chenyfan/nact-channel/socket'

export interface UnixServerOptions { path: string }
export interface UnixServerTransportSpec {
  type: 'unix'
  provider: UnixServerOptions
  nact?: { chunkSize?: number }
}

export default class UnixServerProvider implements ServerTransportProvider<'unix', UnixServerOptions> {
  readonly type = 'unix'
  readonly role = 'server'
  readonly defaultChunkSize = 2 * 1024 * 1024 * 1024

  async listen(options: UnixServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    const server = net.createServer(socket => accept(new SocketChannel(socket)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.path, () => { server.off('error', reject); resolve() })
    })
    return { close: () => new Promise(resolve => server.close(() => resolve())) }
  }
}
