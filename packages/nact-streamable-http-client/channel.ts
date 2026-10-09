import type { Channel } from '@nyirusu/nasdk/NACT'

export const streamableHTTPError = (code: string) => Object.assign(new Error(code), { code })

export class StreamableHTTPChannel implements Channel {
  private receivers = new Set<(frame: readonly Uint8Array[]) => void>()
  private closers = new Set<() => void>()
  private errors = new Set<(reason: unknown) => void>()
  private queue: (readonly Uint8Array[])[] = []
  private queuedBytes = 0
  private ended = false

  constructor(
    private io: {
      send(frame: readonly Uint8Array[]): void | Promise<void>
      close(): void | Promise<void>
    },
    private maxBufferBytes: number,
  ) {}

  get closed() { return this.ended }

  send(frame: readonly Uint8Array[]) {
    if (this.ended) throw streamableHTTPError('transport-closed')
    return this.io.send(frame)
  }

  close() {
    if (this.ended) return
    this.queue = []
    this.queuedBytes = 0
    this.end()
    return this.io.close()
  }

  terminate() { return this.close() }

  onReceive(handler: (frame: readonly Uint8Array[]) => void) {
    this.receivers.add(handler)
    for (const frame of this.queue.splice(0)) handler(frame)
    this.queuedBytes = 0
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

  receive(frame: readonly Uint8Array[]) {
    if (this.ended) return
    if (this.receivers.size) {
      for (const handler of this.receivers) handler(frame)
      return
    }
    const size = frame.reduce((sum, part) => sum + part.byteLength, 0)
    if (this.queuedBytes + size > this.maxBufferBytes) {
      this.fail(streamableHTTPError('receive-buffer-overflow'))
      return
    }
    this.queue.push(frame)
    this.queuedBytes += size
  }

  fail(reason: unknown) {
    if (this.ended) return
    try {
      for (const handler of this.errors) handler(reason)
    } finally {
      void Promise.resolve(this.close()).catch(() => {})
    }
  }

  private end() {
    if (this.ended) return
    this.ended = true
    for (const handler of this.closers) handler()
    this.receivers.clear()
    this.closers.clear()
    this.errors.clear()
  }
}
