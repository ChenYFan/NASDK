import net from 'node:net'
import type { ClientProvider, Channel } from '@nyirusu/nasdk/NACT'
import { makeFrameSplitter } from '@nyirusu/nact-provider-shared'

export interface UnixClientOptions { path: string }
export interface UnixClientTransportSpec {
  type: 'unix'
  provider: UnixClientOptions
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

export default class UnixClientProvider implements ClientProvider<'unix', UnixClientOptions> {
  readonly type = 'unix'
  readonly role = 'client'
  readonly defaultChunkSize = 2 * 1024 * 1024 * 1024

  async dial(options: UnixClientOptions): Promise<Channel> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection(options.path)
      candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate) })
      candidate.once('error', reject)
    })
    return new UnixChannel(socket)
  }
}
