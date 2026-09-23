import { nactInternal } from './errors.ts'
import type {
  CustomTransportEndpoint, CustomTransportSink, TransportChannel, TransportProvider,
} from './types.ts'

export interface CustomTransportSpec<TType extends string, TProvider> {
  type: TType
  provider: TProvider
  nact?: { chunkSize?: number }
}

type ReceiveHandler = (bytes: Uint8Array) => void
type CloseHandler = () => void
type ErrorHandler = (reason: unknown) => void

class CustomChannel implements TransportChannel {
  private receiveHandlers = new Set<ReceiveHandler>()
  private closeHandlers = new Set<CloseHandler>()
  private errorHandlers = new Set<ErrorHandler>()
  private receiveMode?: 'callback' | 'iterator'
  private ended = false
  private queue: Uint8Array[] = []
  private waiters: Array<(result: IteratorResult<Uint8Array>) => void> = []

  constructor(private sink: CustomTransportSink) {}

  send(chunks: readonly Uint8Array[]) { return this.sink.send(chunks) }
  close() { return this.sink.close() }
  terminate() { return this.sink.terminate?.() ?? this.sink.close() }

  onReceive(handler: ReceiveHandler): () => void {
    this.lockReceiveMode('callback')
    this.receiveHandlers.add(handler)
    return () => this.receiveHandlers.delete(handler)
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler)
    return () => this.errorHandlers.delete(handler)
  }

  receive(bytes: Uint8Array) {
    if (this.ended) throw nactInternal('transport-closed', 'cannot receive bytes after the custom transport ended')
    if (this.receiveMode === 'iterator') {
      const waiter = this.waiters.shift()
      if (waiter) waiter({ value: bytes, done: false })
      else this.queue.push(bytes)
      return
    }
    for (const handler of this.receiveHandlers) handler(bytes)
  }

  closed() {
    if (this.ended) return
    this.ended = true
    this.finish()
  }

  failed(reason: unknown) {
    if (this.ended) return
    this.ended = true
    for (const handler of this.errorHandlers) handler(reason)
    this.finish()
  }

  private finish() {
    for (const handler of this.closeHandlers) handler()
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    this.lockReceiveMode('iterator')
    return {
      next: () => {
        const value = this.queue.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise(resolve => this.waiters.push(resolve))
      },
    }
  }

  private lockReceiveMode(mode: 'callback' | 'iterator') {
    if (this.receiveMode && this.receiveMode !== mode)
      throw nactInternal('receive-mode-conflict', `transport receive mode is already '${this.receiveMode}'`)
    this.receiveMode = mode
  }
}

type OpenChannel = (channel: TransportChannel, chunkSize: number) => string

export class CustomTransportProvider<TType extends string, TProvider>
  implements TransportProvider<TType, TProvider> {
  readonly type: TType
  readonly role = 'custom'
  readonly provider: TProvider
  readonly defaultChunkSize: number
  private openChannel?: OpenChannel

  constructor(spec: CustomTransportSpec<TType, TProvider>) {
    this.type = spec.type
    this.provider = spec.provider
    this.defaultChunkSize = spec.nact?.chunkSize ?? 100 * 1024 * 1024
  }

  open(sink: CustomTransportSink): CustomTransportEndpoint {
    if (!this.openChannel)
      throw nactInternal('provider-not-registered', 'register CustomTransportProvider with nact.use() before open()')
    const channel = new CustomChannel(sink)
    const peerId = this.openChannel(channel, this.defaultChunkSize)
    return {
      peerId,
      receive: bytes => channel.receive(bytes),
      closed: () => channel.closed(),
      failed: reason => channel.failed(reason),
    }
  }

  /** @internal Called by NACT.use(). */
  attach(openChannel: OpenChannel) {
    if (this.openChannel)
      throw nactInternal('provider-already-registered', 'CustomTransportProvider is already registered')
    this.openChannel = openChannel
  }
}
