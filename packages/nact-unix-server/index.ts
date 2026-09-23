import net from 'node:net'
import type { ServerHandle, ServerTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

const receiveModeConflict = () => Object.assign(new Error('transport receive mode conflict'), { code: 'receive-mode-conflict' })

export interface UnixServerOptions { path: string }
export interface UnixServerTransportSpec {
  type: 'unix'
  provider: UnixServerOptions
  nact?: { chunkSize?: number }
}

class UnixChannel implements TransportChannel {
  private receiveMode?: 'callback' | 'iterator'
  constructor(private socket: net.Socket) {}
  send(chunks: readonly Uint8Array[]) { for (const chunk of chunks) this.socket.write(chunk) }
  close() { this.socket.end() }
  terminate() { this.socket.destroy() }
  onReceive(handler: (bytes: Uint8Array) => void) {
    this.lock('callback'); this.socket.on('data', handler); return () => this.socket.off('data', handler)
  }
  onClose(handler: () => void) { this.socket.on('close', handler); return () => this.socket.off('close', handler) }
  onError(handler: (reason: unknown) => void) {
    this.socket.on('error', handler); return () => this.socket.off('error', handler)
  }
  async *[Symbol.asyncIterator]() {
    this.lock('iterator')
    for await (const chunk of this.socket) yield chunk
  }
  private lock(mode: 'callback' | 'iterator') {
    if (this.receiveMode && this.receiveMode !== mode) throw receiveModeConflict()
    this.receiveMode = mode
  }
}

export default class UnixServerProvider implements ServerTransportProvider<'unix', UnixServerOptions> {
  readonly type = 'unix'
  readonly role = 'server'
  readonly defaultChunkSize = 2 * 1024 * 1024 * 1024

  async listen(options: UnixServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    const server = net.createServer(socket => accept(new UnixChannel(socket)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.path, () => { server.off('error', reject); resolve() })
    })
    return { close: () => new Promise(resolve => server.close(() => resolve())) }
  }
}
