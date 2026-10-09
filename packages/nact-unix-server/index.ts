import net from 'node:net'
import type { ServerHandle, ServerProvider, Channel } from '@nyirusu/nasdk/NACT'
import { makeFrameSplitter } from '@nyirusu/nact-provider-shared'

export interface UnixServerOptions { path: string }
export interface UnixServerTransportSpec {
  type: 'unix'
  provider: UnixServerOptions
  nact?: { chunkSize?: number }
}

class UnixChannel implements Channel {
  constructor(private socket: net.Socket) {}
  send(frame: readonly Uint8Array[]) {
    if (this.socket.destroyed || !this.socket.writable) throw Object.assign(new Error('transport-closed'), { code: 'transport-closed' })
    for (const part of frame) this.socket.write(part)
  }
  close() { this.socket.end() }
  terminate() { this.socket.destroy() }
  onReceive(handler: (frame: readonly Uint8Array[]) => void) {
    const push = makeFrameSplitter(handler, reason => this.socket.destroy(reason))
    this.socket.on('data', push)
    return () => this.socket.off('data', push)
  }
  onClose(handler: () => void) { this.socket.on('close', handler); return () => this.socket.off('close', handler) }
  onError(handler: (reason: unknown) => void) {
    this.socket.on('error', handler); return () => this.socket.off('error', handler)
  }
}

export default class UnixServerProvider implements ServerProvider<'unix', UnixServerOptions> {
  readonly type = 'unix'
  readonly role = 'server'
  readonly defaultChunkSize = 2 * 1024 * 1024 * 1024

  async listen(options: UnixServerOptions, accept: (channel: Channel) => void): Promise<ServerHandle> {
    const server = net.createServer(socket => accept(new UnixChannel(socket)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.path, () => { server.off('error', reject); resolve() })
    })
    return { close: () => new Promise(resolve => server.close(() => resolve())) }
  }
}
