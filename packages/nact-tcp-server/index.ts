import net from 'node:net'
import type { ServerHandle, ServerProvider, Channel } from '@nyirusu/nasdk/NACT'
import { makeFrameSplitter } from '@nyirusu/nact-provider-shared'

export interface TcpServerOptions {
  host: string
  port: number
}
export interface TcpServerTransportSpec {
  type: 'tcp'
  provider: TcpServerOptions
  nact?: { chunkSize?: number }
}

class TCPChannel implements Channel {
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

export default class TCPServerProvider implements ServerProvider<'tcp', TcpServerOptions> {
  readonly type = 'tcp'
  readonly role = 'server'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async listen(options: TcpServerOptions, accept: (channel: Channel) => void): Promise<ServerHandle> {
    const server = net.createServer((socket) => {
      accept(new TCPChannel(socket))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: options.host, port: options.port }, () => { server.off('error', reject); resolve() })
    })
    return { close: () => new Promise(resolve => server.close(() => resolve())) }
  }
}
