import http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import type { ServerHandle, ServerProvider, Channel } from '@nyirusu/nasdk/NACT'

export type WebSocketServerOptions = {
  host: string
  port: number
  path?: string
  noServer?: false
} | {
  noServer: true
  path?: never
  host?: never
  port?: never
}
export interface WebSocketServerTransportSpec {
  type: 'websocket'
  provider: WebSocketServerOptions
  nact?: { chunkSize?: number }
}

class WebSocketChannel implements Channel {
  private errorHandlers = new Set<(reason: unknown) => void>()
  constructor(private socket: WebSocket) {}
  send(frame: readonly Uint8Array[]) {
    if (this.socket.readyState !== 1) throw Object.assign(new Error('transport-closed'), { code: 'transport-closed' })
    const size = frame.reduce((sum, part) => sum + part.byteLength, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of frame) { bytes.set(part, offset); offset += part.byteLength }
    this.socket.send(bytes)
  }
  close() { this.socket.close() }
  terminate() { this.socket.terminate() }
  onReceive(handler: (frame: readonly Uint8Array[]) => void) {
    const listener = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return this.fail('non-binary-frame')
      handler([data as Buffer])   // default binaryType 'nodebuffer': one Buffer per message
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
  private fail(reason: unknown) { for (const handler of this.errorHandlers) handler(reason) }
}

export default class WebSocketServerProvider
  implements ServerProvider<'websocket', WebSocketServerOptions> {
  readonly type = 'websocket'
  readonly role = 'server'
  readonly defaultChunkSize = 100 * 1024 * 1024
  private websocket?: WebSocketServer
  private detach = new Set<() => void>()

  attach(server: http.Server, options: { path?: string } = {}): () => void {
    if (!this.websocket) throw Object.assign(new Error('provider-not-listening'), { code: 'provider-not-listening' })
    return this.attachServer(server, options)
  }

  private attachServer(server: http.Server, options: { path?: string }, owned = false): () => void {
    const websocket = this.websocket!
    const upgrade = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      if (options.path && new URL(request.url ?? '/', 'http://localhost').pathname !== options.path) {
        if (owned) socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return
      }
      websocket.handleUpgrade(request, socket, head, ws => websocket.emit('connection', ws, request))
    }
    const detach = () => { server.off('upgrade', upgrade); this.detach.delete(detach) }
    server.on('upgrade', upgrade)
    this.detach.add(detach)
    return detach
  }

  async listen(options: WebSocketServerOptions, accept: (channel: Channel) => void): Promise<ServerHandle> {
    if (this.websocket) throw Object.assign(new Error('provider-already-listening'), { code: 'provider-already-listening' })
    const server = options.noServer ? undefined : http.createServer()
    const websocket = new WebSocketServer({ noServer: true, perMessageDeflate: false })
    this.websocket = websocket
    websocket.on('connection', socket => accept(new WebSocketChannel(socket)))
    if (server && !options.noServer) {
      this.attachServer(server, options, true)
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(options.port, options.host, () => { server.off('error', reject); resolve() })
        })
      } catch (reason) {
        for (const detach of this.detach) detach()
        this.websocket = undefined
        websocket.close()
        throw reason
      }
    }
    let closing: Promise<void> | undefined
    return {
      close: () => closing ??= new Promise(resolve => {
        this.websocket = undefined
        for (const detach of this.detach) detach()
        for (const socket of websocket.clients) socket.terminate()
        websocket.close(() => {
          if (server) server.close(() => resolve())
          else resolve()
        })
      }),
    }
  }
}
