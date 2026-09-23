import net from 'node:net'
import type { ServerHandle, ServerTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

const receiveModeConflict = () => Object.assign(new Error('transport receive mode conflict'), { code: 'receive-mode-conflict' })

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

class TCPChannel implements TransportChannel {
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

export default class TCPServerProvider implements ServerTransportProvider<'tcp', TcpServerOptions> {
  readonly type = 'tcp'
  readonly role = 'server'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async listen(options: TcpServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    const server = net.createServer((socket) => {
      if (options.keepAlive !== false) socket.setKeepAlive(true, options.keepAlive ?? 30_000)
      accept(new TCPChannel(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: options.host, port: options.port }, () => { server.off('error', reject); resolve() })
    })
    return { close: () => new Promise(resolve => server.close(() => resolve())) }
  }
}
