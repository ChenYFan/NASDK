import type { TransportChannel } from '@chenyfan/nasdk/NACT'

export const transportError = (code: string) => Object.assign(new Error(code), { code })

/** A bounded, single-consumer byte channel. Concrete providers own physical I/O. */
export class ByteChannel implements TransportChannel {
  private receivers = new Set<(bytes: Uint8Array) => void>()
  private closers = new Set<() => void>()
  private errors = new Set<(reason: unknown) => void>()
  private mode?: 'callback' | 'iterator'
  private queue: Uint8Array[] = []
  private queuedBytes = 0
  private waiter?: (result: IteratorResult<Uint8Array>) => void
  private failure?: unknown
  private ended = false
  get closed() { return this.ended }

  constructor(private io: {
    send(chunks: readonly Uint8Array[]): void | Promise<void>
    close(): void | Promise<void>
  }, private maxBufferBytes = 4 * 1024 * 1024) {}

  send(chunks: readonly Uint8Array[]) {
    if (this.ended) throw transportError('transport-closed')
    return this.io.send(chunks)
  }
  close() {
    if (this.ended) return
    this.queue = []; this.queuedBytes = 0
    this.end()
    return this.io.close()
  }
  terminate() { return this.close() }
  onReceive(handler: (bytes: Uint8Array) => void) {
    this.lock('callback')
    this.receivers.add(handler)
    for (const bytes of this.queue.splice(0)) handler(bytes)
    this.queuedBytes = 0
    return () => { this.receivers.delete(handler) }
  }
  onClose(handler: () => void) {
    if (this.ended) queueMicrotask(handler)
    else this.closers.add(handler)
    return () => { this.closers.delete(handler) }
  }
  onError(handler: (reason: unknown) => void) {
    this.errors.add(handler)
    return () => { this.errors.delete(handler) }
  }
  receive(bytes: Uint8Array) {
    if (this.ended || !bytes.byteLength) return
    if (this.mode === 'callback' && this.receivers.size) {
      for (const handler of this.receivers) handler(bytes)
    } else if (this.waiter) {
      const resolve = this.waiter; this.waiter = undefined
      resolve({ value: bytes, done: false })
    } else {
      if (this.queuedBytes + bytes.byteLength > this.maxBufferBytes) {
        this.fail(transportError('receive-buffer-overflow')); return
      }
      this.queue.push(bytes.slice()); this.queuedBytes += bytes.byteLength
    }
  }
  fail(reason: unknown) {
    if (this.ended) return
    this.failure = reason
    try { for (const handler of this.errors) handler(reason) }
    finally { void Promise.resolve(this.close()).catch(() => {}) }
  }
  end() {
    if (this.ended) return
    this.ended = true
    this.waiter?.({ value: undefined, done: true }); this.waiter = undefined
    for (const handler of this.closers) handler()
    this.receivers.clear(); this.closers.clear(); this.errors.clear()
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    this.lock('iterator')
    return {
      next: async () => {
        if (this.failure !== undefined) throw this.failure
        const bytes = this.queue.shift()
        if (bytes) { this.queuedBytes -= bytes.byteLength; return { value: bytes, done: false } }
        if (this.ended) return { value: undefined, done: true }
        if (this.waiter) throw transportError('concurrent-receive')
        const result = await new Promise<IteratorResult<Uint8Array>>(resolve => { this.waiter = resolve })
        if (this.failure !== undefined) throw this.failure
        return result
      },
      return: async () => { await this.close(); return { value: undefined, done: true } },
    }
  }
  private lock(mode: 'callback' | 'iterator') {
    if (this.mode && (this.mode !== mode || mode === 'iterator')) throw transportError('receive-mode-conflict')
    this.mode = mode
  }
}
