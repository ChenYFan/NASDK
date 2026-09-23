import http from 'node:http'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { ServerHandle, ServerTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'

const receiveModeConflict = () => Object.assign(new Error('transport receive mode conflict'), { code: 'receive-mode-conflict' })

export interface WebSocketServerOptions {
  host: string
  port: number
  path?: string
}
export interface WebSocketServerTransportSpec {
  type: 'websocket'
  provider: WebSocketServerOptions
  nact?: { chunkSize?: number }
}

function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const size = data.reduce((sum, part) => sum + part.byteLength, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of data) { bytes.set(part, offset); offset += part.byteLength }
    return bytes
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data
}

class WebSocketChannel implements TransportChannel {
  private receiveMode?: 'callback' | 'iterator'
  private errorHandlers = new Set<(reason: unknown) => void>()
  constructor(private socket: WebSocket) {}
  send(chunks: readonly Uint8Array[]) {
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const frame = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { frame.set(chunk, offset); offset += chunk.byteLength }
    this.socket.send(frame)
  }
  close() { this.socket.close() }
  terminate() { this.socket.terminate() }
  onReceive(handler: (bytes: Uint8Array) => void) {
    this.lock('callback')
    const listener = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return this.fail('non-binary-frame')
      handler(bytesOf(data))
    }
    this.socket.on('message', listener)
    return () => this.socket.off('message', listener)
  }
  onClose(handler: () => void) { this.socket.on('close', handler); return () => this.socket.off('close', handler) }
  onError(handler: (reason: unknown) => void) {
    this.errorHandlers.add(handler)
    this.socket.on('error', handler)
    return () => { this.errorHandlers.delete(handler); this.socket.off('error', handler) }
  }
  async *[Symbol.asyncIterator]() {
    this.lock('iterator')
    const queue: Uint8Array[] = []
    let wake: (() => void) | undefined
    let ended = false
    const onMessage = (data: RawData, isBinary: boolean) => { if (isBinary) queue.push(bytesOf(data)); wake?.() }
    const onClose = () => { ended = true; wake?.() }
    this.socket.on('message', onMessage); this.socket.on('close', onClose)
    try {
      while (!ended || queue.length) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
        const bytes = queue.shift()
        if (bytes) yield bytes
      }
    } finally {
      this.socket.off('message', onMessage); this.socket.off('close', onClose)
    }
  }
  private lock(mode: 'callback' | 'iterator') {
    if (this.receiveMode && this.receiveMode !== mode) throw receiveModeConflict()
    this.receiveMode = mode
  }
  private fail(reason: unknown) { for (const handler of this.errorHandlers) handler(reason) }
}

export default class WebSocketServerProvider
  implements ServerTransportProvider<'websocket', WebSocketServerOptions> {
  readonly type = 'websocket'
  readonly role = 'server'
  readonly defaultChunkSize = 100 * 1024 * 1024

  async listen(options: WebSocketServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    const server = http.createServer()
    const websocket = new WebSocketServer({ server, path: options.path, perMessageDeflate: false })
    websocket.on('connection', socket => accept(new WebSocketChannel(socket)))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, options.host, () => { server.off('error', reject); resolve() })
    })
    return {
      close: () => new Promise(resolve => websocket.close(() => server.close(() => resolve()))),
    }
  }
}
