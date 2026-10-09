import type { Channel, ServerHandle, ServerProvider } from '@nyirusu/nasdk/NACT'

export interface CloudflareWorkerWebSocketServerOptions {
  authorize?: (request: Request) => boolean | Promise<boolean>
}

export interface CloudflareWorkerWebSocketServerTransportSpec {
  type: 'websocket-cloudflare-worker'
  provider: CloudflareWorkerWebSocketServerOptions
  nact?: { chunkSize?: number }
}

const transportError = (code: string) => Object.assign(new Error(code), { code })

class WorkerWebSocketChannel implements Channel {
  private errorHandlers = new Set<(reason: unknown) => void>()
  constructor(private socket: WebSocket) {}

  send(frame: readonly Uint8Array[]) {
    if (this.socket.readyState !== 1) throw transportError('transport-closed')
    const bytes = new Uint8Array(frame.reduce((size, part) => size + part.byteLength, 0))
    let offset = 0
    for (const part of frame) { bytes.set(part, offset); offset += part.byteLength }
    this.socket.send(bytes)
  }

  close() { this.socket.close(1000, 'NACT closed') }

  onReceive(handler: (frame: readonly Uint8Array[]) => void) {
    const listener = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        for (const handler of this.errorHandlers) handler(transportError('non-binary-frame'))
        return
      }
      handler([new Uint8Array(event.data as ArrayBuffer)])
    }
    this.socket.addEventListener('message', listener)
    return () => this.socket.removeEventListener('message', listener)
  }

  onClose(handler: () => void) {
    const listener = () => {
      // Older compatibility dates require explicitly replying to the peer's Close frame.
      if (this.socket.readyState === 2) this.socket.close(1000, 'NACT closed')
      handler()
    }
    this.socket.addEventListener('close', listener)
    return () => this.socket.removeEventListener('close', listener)
  }

  onError(handler: (reason: unknown) => void) {
    this.errorHandlers.add(handler)
    const listener = (event: Event) => handler((event as ErrorEvent).error ?? transportError('transport-error'))
    this.socket.addEventListener('error', listener)
    return () => { this.errorHandlers.delete(handler); this.socket.removeEventListener('error', listener) }
  }
}

export default class CloudflareWorkerWebSocketServerProvider
  implements ServerProvider<'websocket-cloudflare-worker', CloudflareWorkerWebSocketServerOptions> {
  readonly type = 'websocket-cloudflare-worker'
  readonly role = 'server'
  readonly defaultChunkSize = 64 * 1024
  private accept?: (channel: Channel) => void
  private options?: CloudflareWorkerWebSocketServerOptions
  private channels = new Set<WorkerWebSocketChannel>()

  async listen(options: CloudflareWorkerWebSocketServerOptions, accept: (channel: Channel) => void): Promise<ServerHandle> {
    if (this.accept) throw transportError('provider-already-listening')
    this.options = options
    this.accept = accept
    let closed = false
    return {
      close: async () => {
        if (closed) return
        closed = true
        this.accept = undefined
        this.options = undefined
        for (const channel of this.channels) channel.close()
        this.channels.clear()
      },
    }
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const accept = this.accept
    const options = this.options
    if (!accept || !options) return new Response(null, { status: 503 })
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 426, headers: { Upgrade: 'websocket' } })
    if (options.authorize && !await options.authorize(request)) return new Response(null, { status: 403 })
    if (this.accept !== accept || this.options !== options) return new Response(null, { status: 503 })
    const pair = new WebSocketPair()
    const socket = pair[1]
    // New compatibility dates default to Blob; set this before accepting any incoming data.
    socket.binaryType = 'arraybuffer'
    const channel = new WorkerWebSocketChannel(socket)
    this.channels.add(channel)
    channel.onClose(() => this.channels.delete(channel))
    try {
      accept(channel)
      socket.accept()
      return new Response(null, { status: 101, webSocket: pair[0] })
    } catch (reason) {
      this.channels.delete(channel)
      socket.accept()
      channel.close()
      throw reason
    }
  }
}
