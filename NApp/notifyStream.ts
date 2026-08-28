/**
 * NotifyStream — the async-iterable half of `NApp.subscribe`: a bounded push-to-pull queue.
 *
 * The subscription is live from the moment `subscribe` goes out, so arrivals can precede the consumer —
 * they are buffered and replayed in order once the loop starts.
 *
 * ENDING: source side = `end()` (buffered items still drain first); consumer side = `break`/`return`/throw,
 * which fires `onCancel` (NApp sends a real unsubscribe). Bounded: at the cap the OLDEST item is dropped
 * and reported via `onOverflow`.
 */

/** Standalone default; streams created by NApp use its queueMaxCount. */
export const NOTIFY_BUFFER_MAX = 1024

export interface NotifyStreamOpts {
  max?: number
  /** Called with the dropped item when the buffer is full. */
  onOverflow?: (dropped: unknown) => void
  /** Called when the CONSUMER walks away (`break`/`return`/throw). Not called on natural `end()`. */
  onCancel?: () => void
}

/** A bounded push-to-pull queue exposed as an AsyncIterable; one loop per stream. */
export class NotifyStream<T = any> implements AsyncIterable<T> {
  private queue: T[] = []
  private ended = false
  /** Set while a consumer is parked on an empty queue. Exactly one can wait: one stream, one loop. */
  private waiting?: (r: IteratorResult<T>) => void
  private readonly max: number
  private readonly onOverflow?: (dropped: unknown) => void
  private readonly onCancel?: () => void

  constructor(opts: NotifyStreamOpts = {}) {
    this.max = opts.max ?? NOTIFY_BUFFER_MAX
    this.onOverflow = opts.onOverflow
    this.onCancel = opts.onCancel
  }

  /** Producer: one notify arrived. Ignored after `end()`. */
  push(value: T) {
    if (this.ended) return
    // A parked consumer takes it directly.
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

  /** Producer: the subscription is over (idempotent). Buffered items still drain first. */
  end() {
    if (this.ended) return
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = undefined
      resolve({ value: undefined as any, done: true })
    }
  }

  /** Whether the subscription behind this stream is over (buffered items may still be pending). */
  get closed(): boolean { return this.ended }
  /** Items received but not yet consumed. */
  get pending(): number { return this.queue.length }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        // Buffered items win over the ended flag.
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as any, done: true })
        return new Promise<IteratorResult<T>>((resolve) => { this.waiting = resolve })
      },
      // `break`/`return`/throw lands here → cancel the subscription (onCancel), unless it already ended.
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
