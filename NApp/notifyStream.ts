/**
 * NotifyStream — the async-iterable half of `NApp.subscribe`.
 *
 * A subscription is a push source (notifies arrive when the peer emits) consumed by a pull loop
 * (`for await`). This bridges the two, and the whole design is about the gap between them:
 *
 *   const [sub, stream] = app.subscribe('core', 'some:event')
 *   await somethingSlow()                    // ← notifies may already be arriving
 *   for await (const chunk of stream) { … }  // ← consumption starts only here
 *
 * The subscription is live from the moment `subscribe` goes out — deliberately, so the first notify is never
 * lost to a round trip. That means arrivals can precede the consumer, so they are BUFFERED (bounded; see
 * below) and replayed in order once the loop starts.
 *
 * ── ENDING ────────────────────────────────────────────────────────────────────────────────────────────
 * Two directions, and they are not symmetric:
 *
 *   the SOURCE ends   — `end()`, called from ONE place: the ListenTable record leaving the table, whatever
 *                       removed it (unsubscribe, the peer disconnecting, terminate()). So "the subscription
 *                       is gone" and "the loop exits" are the same event, with no fourth path to keep in sync.
 *                       Items already buffered are still drained first: ending is not discarding.
 *
 *   the CONSUMER ends — `break` / `return` / a throw in the loop body. That is treated as CANCELLING the
 *                       subscription: `onCancel` fires and NApp sends a real unsubscribe. Walking away from
 *                       the stream and keeping the subscription alive is not a state worth having.
 *
 * ── BOUNDED, AND LOUD ABOUT IT ────────────────────────────────────────────────────────────────────────
 * An unbounded buffer turns a consumer that never runs into a memory leak. At the cap the OLDEST item is
 * dropped, because for a process stream the newest is the interesting one. A drop is reported through
 * `onOverflow` rather than swallowed — silent truncation would read exactly like a peer that stopped sending.
 *
 * Nothing here is subscription-specific; it is a bounded push-to-pull queue. It lives in NApp/ because that is
 * the only layer that hands one out — NACP delivers to a callback and has no opinion about iteration.
 */

/** Cap on unconsumed items. Past this, the oldest is dropped and `onOverflow` fires. */
export const NOTIFY_BUFFER_MAX = 1024

export interface NotifyStreamOpts {
  /** Cap on buffered-but-unconsumed items. Defaults to NOTIFY_BUFFER_MAX. */
  max?: number
  /** Called with the dropped item when the buffer is full. Use it to emit a warning; do not throw. */
  onOverflow?: (dropped: unknown) => void
  /**
   * Called when the CONSUMER walks away — `break`, `return`, or a throw inside the `for await` body. Leaving
   * the loop is treated as cancelling the subscription, so NApp wires this to a real `unsubscribe`.
   *
   * Not called when the stream ends on its own (`end()`): there the subscription is already gone, and asking
   * the peer to cancel something it has forgotten would answer `unknown-subscription`.
   */
  onCancel?: () => void
}

/**
 * A bounded push-to-pull queue exposed as an AsyncIterable.
 *
 * `push` / `end` are the producer side (NApp wires them to the subscription's listener and its onEnd);
 * `[Symbol.asyncIterator]` is the consumer side. Iterating twice concurrently is not supported — a
 * subscription has one stream, and a second loop would silently steal items from the first.
 */
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

  /** Producer: one notify arrived. Ignored after `end()` — a closed subscription cannot yield more. */
  push(value: T) {
    if (this.ended) return
    // A parked consumer takes it directly; queueing first would only add a turn of latency.
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

  /**
   * Producer: the subscription is over. Idempotent — the ListenTable guards against a double call too, but a
   * stream that ended twice would be a bug either way, so it is cheap to be safe here.
   *
   * A consumer parked on an empty queue is released immediately with `done`. One that still has buffered items
   * keeps draining them first: `end` closes the source, it does not discard what already arrived.
   */
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
        // Buffered items win over the ended flag: drain first, report done after.
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as any, done: true })
        return new Promise<IteratorResult<T>>((resolve) => { this.waiting = resolve })
      },
      // `break` / `return` / a throw inside the loop lands here. Leaving the loop IS cancelling the
      // subscription: `onCancel` fires and NApp turns it into a real `unsubscribe`. So a callback passed to the
      // same `subscribe` call stops receiving too — necessarily, since the peer is told to stop sending.
      //
      // Not fired when the stream already ended by itself: `ended` means the ListenTable record is gone, and
      // cancelling a subscription the peer has forgotten would just draw `unknown-subscription`.
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
