import type { ClientTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

const receiveModeConflict = () => Object.assign(new Error('transport receive mode conflict'), { code: 'receive-mode-conflict' })

export interface WebSocketClientOptions { url: string }
export interface WebSocketClientTransportSpec {
  type: 'websocket'
  provider: WebSocketClientOptions
  nact?: { chunkSize?: number }
}

interface SocketLike {
  binaryType: BinaryType
  readonly readyState: number
  send(data: Uint8Array): void
  close(): void
  terminate?: () => void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

class WebSocketChannel implements TransportChannel {
  private receiveMode?: 'callback' | 'iterator'
  private errorHandlers = new Set<(reason: unknown) => void>()
  constructor(private socket: SocketLike) {}
  send(chunks: readonly Uint8Array[]) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const frame = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { frame.set(chunk, offset); offset += chunk.byteLength }
    this.socket.send(frame)
  }
  close() { this.socket.close() }
  terminate() { this.socket.terminate?.() ?? this.socket.close() }
  onReceive(handler: (bytes: Uint8Array) => void) {
    this.lock('callback')
    const listener = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) handler(new Uint8Array(event.data))
      else if (ArrayBuffer.isView(event.data)) handler(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength))
      else this.fail('non-binary-frame')
    }
    this.socket.addEventListener('message', listener)
    return () => this.socket.removeEventListener('message', listener)
  }
  onClose(handler: () => void) {
    this.socket.addEventListener('close', handler); return () => this.socket.removeEventListener('close', handler)
  }
  onError(handler: (reason: unknown) => void) {
    this.errorHandlers.add(handler)
    const listener = (reason: unknown) => this.fail(reason)
    this.socket.addEventListener('error', listener)
    return () => { this.errorHandlers.delete(handler); this.socket.removeEventListener('error', listener) }
  }
  async *[Symbol.asyncIterator]() {
    this.lock('iterator')
    const queue: Uint8Array[] = []
    let wake: (() => void) | undefined
    let ended = false
    const onMessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) queue.push(new Uint8Array(event.data))
      else if (ArrayBuffer.isView(event.data)) queue.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength))
      wake?.()
    }
    const onClose = () => { ended = true; wake?.() }
    this.socket.addEventListener('message', onMessage); this.socket.addEventListener('close', onClose)
    try {
      while (!ended || queue.length) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
        const bytes = queue.shift()
        if (bytes) yield bytes
      }
    } finally {
      this.socket.removeEventListener('message', onMessage); this.socket.removeEventListener('close', onClose)
    }
  }
  private lock(mode: 'callback' | 'iterator') {
    if (this.receiveMode && this.receiveMode !== mode) throw receiveModeConflict()
    this.receiveMode = mode
  }
  private fail(reason: unknown) { for (const handler of this.errorHandlers) handler(reason) }
}

export default class WebSocketClientProvider
  implements ClientTransportProvider<'websocket', WebSocketClientOptions> {
  readonly type = 'websocket'
  readonly role = 'client'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async dial(options: WebSocketClientOptions): Promise<TransportChannel> {
    const Constructor = typeof WebSocket === 'undefined'
      ? (await import('ws')).default
      : WebSocket
    const socket = new Constructor(options.url) as unknown as SocketLike
    socket.binaryType = 'arraybuffer'
    await new Promise<void>((resolve, reject) => {
      const open = () => { cleanup(); resolve() }
      const error = (reason: unknown) => { cleanup(); reject(reason) }
      const cleanup = () => {
        socket.removeEventListener('open', open)
        socket.removeEventListener('error', error)
      }
      socket.addEventListener('open', open)
      socket.addEventListener('error', error)
    })
    return new WebSocketChannel(socket)
  }
}
