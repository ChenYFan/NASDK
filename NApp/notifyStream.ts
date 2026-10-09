/** Standalone default; streams created by NApp use its queueMaxCount. */
export const NOTIFY_BUFFER_MAX = 1024

export interface NotifyStreamOpts {
  max?: number
  /** Called with the dropped item when the buffer is full. */
  onOverflow?: (dropped: unknown) => void
  /** Consumer side `break`/`return`/throw; not called on natural `end()`. */
  onCancel?: () => void
}

/** A bounded push-to-pull queue exposed as an AsyncIterable; one loop per stream. */
export class NotifyStream<T = any> implements AsyncIterable<T> {
  private queue: T[] = []
  private ended = false
  /** Set while the single consumer is parked on an empty queue. */
  private waiting?: (r: IteratorResult<T>) => void
  private readonly max: number
  private readonly onOverflow?: (dropped: unknown) => void
  private readonly onCancel?: () => void

  constructor(opts: NotifyStreamOpts = {}) {
    this.max = opts.max ?? NOTIFY_BUFFER_MAX
    this.onOverflow = opts.onOverflow
    this.onCancel = opts.onCancel
  }

  push(value: T) {
    if (this.ended) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value, done: false })
      return
    }
    if (this.queue.length >= this.max) {
      const dropped = this.queue.shift()
      this.onOverflow?.(dropped)
    }
    this.queue.push(value)
  }

  end() {
    if (this.ended) return
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: undefined as any, done: true })
    }
  }

  get closed(): boolean { return this.ended }
  get pending(): number { return this.queue.length }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as any, done: true })
        return new Promise<IteratorResult<T>>((resolve) => { this.waiting = resolve })
      },
      return: (): Promise<IteratorResult<T>> => {
        this.queue = []
        if (!this.ended) {
          this.ended = true
          try { this.onCancel?.() } catch { /* cancellation is best-effort */ }
        }
        return Promise.resolve({ value: undefined as any, done: true })
      },
    }
  }
}
