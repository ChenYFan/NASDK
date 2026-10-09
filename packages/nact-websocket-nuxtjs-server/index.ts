import type { Channel, ServerHandle, ServerProvider } from '@nyirusu/nasdk/NACT'
import type { Hooks, Peer } from 'crossws'

export interface NuxtWebSocketServerOptions {
  authorize?: (request: Parameters<Hooks['upgrade']>[0]) => boolean | Promise<boolean>
}

export interface NuxtWebSocketServerTransportSpec {
  type: 'websocket-nuxtjs'
  provider?: NuxtWebSocketServerOptions
  nact?: { chunkSize?: number }
}

const transportError = (code: string) => Object.assign(new Error(code), { code })

class NuxtWebSocketChannel implements Channel {
  private receivers = new Set<(frame: readonly Uint8Array[]) => void>()
  private closers = new Set<() => void>()
  private errors = new Set<(reason: unknown) => void>()
  private ended = false
  constructor(private peer: Peer) {}

  send(frame: readonly Uint8Array[]) {
    if (this.ended) throw transportError('transport-closed')
    const bytes = new Uint8Array(frame.reduce((size, part) => size + part.byteLength, 0))
    let offset = 0
    for (const part of frame) { bytes.set(part, offset); offset += part.byteLength }
    this.peer.send(bytes, { compress: false })
  }
  close() { this.end(); this.peer.close(1000, 'NACT closed') }
  terminate() { this.end(); this.peer.terminate() }
  onReceive(handler: (frame: readonly Uint8Array[]) => void) {
    this.receivers.add(handler)
    return () => this.receivers.delete(handler)
  }
  onClose(handler: () => void) {
    if (this.ended) queueMicrotask(handler)
    else this.closers.add(handler)
    return () => this.closers.delete(handler)
  }
  onError(handler: (reason: unknown) => void) {
    this.errors.add(handler)
    return () => this.errors.delete(handler)
  }
  receive(bytes: Uint8Array) {
    if (!this.ended) for (const handler of this.receivers) handler([bytes])
  }
  fail(reason: unknown) {
    if (this.ended) return
    try { for (const handler of this.errors) handler(reason) }
    finally { this.terminate() }
  }
  end() {
    if (this.ended) return
    this.ended = true
    for (const handler of this.closers) handler()
    this.receivers.clear()
    this.closers.clear()
    this.errors.clear()
  }
}

// Nitro/CrossWS owns routing and upgrade; this Provider only handles accepted peers.
export default class NuxtWebSocketServerProvider
  implements ServerProvider<'websocket-nuxtjs', NuxtWebSocketServerOptions> {
  readonly type = 'websocket-nuxtjs'
  readonly role = 'server'
  readonly defaultChunkSize = 64 * 1024
  private accept?: (channel: Channel) => void
  private options?: NuxtWebSocketServerOptions
  private channels = new Map<Peer, NuxtWebSocketChannel>()
  private admissions = new WeakMap<object, (channel: Channel) => void>()

  async listen(options: NuxtWebSocketServerOptions, accept: (channel: Channel) => void): Promise<ServerHandle> {
    if (this.accept) throw transportError('provider-already-listening')
    this.accept = accept
    this.options = options
    let closed = false
    return {
      close: async () => {
        if (closed) return
        closed = true
        this.accept = undefined
        this.options = undefined
        this.admissions = new WeakMap()
        for (const channel of this.channels.values()) channel.terminate()
        this.channels.clear()
      },
    }
  }

  readonly hooks: Hooks = {
    upgrade: async request => {
      const accept = this.accept
      const options = this.options
      if (!accept || !options) return new Response(null, { status: 503 })
      if (options.authorize && !await options.authorize(request)) return new Response(null, { status: 403 })
      if (this.accept !== accept) return new Response(null, { status: 503 })
      this.admissions.set(request.context, accept)
    },
    open: peer => {
      const accept = this.accept
      if (!accept || this.admissions.get(peer.context) !== accept) { peer.terminate(); return }
      this.admissions.delete(peer.context)
      const channel = new NuxtWebSocketChannel(peer)
      this.channels.set(peer, channel)
      channel.onClose(() => this.channels.delete(peer))
      try { accept(channel) } catch (reason) { channel.fail(reason); throw reason }
    },
    message: (peer, message) => {
      const channel = this.channels.get(peer)
      if (typeof message.rawData === 'string') channel?.fail(transportError('non-binary-frame'))
      else channel?.receive(message.uint8Array())
    },
    close: peer => { this.channels.get(peer)?.end() },
    error: (peer, reason) => { this.channels.get(peer)?.fail(reason) },
  }
}
