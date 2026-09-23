import net from 'node:net'
import type { ClientTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

const receiveModeConflict = () => Object.assign(new Error('transport receive mode conflict'), { code: 'receive-mode-conflict' })

export interface UnixClientOptions { path: string }
export interface UnixClientTransportSpec {
  type: 'unix'
  provider: UnixClientOptions
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
    return new UnixChannel(socket)
  }
}
