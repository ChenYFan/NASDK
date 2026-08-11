/**
 * NASDK EventBus — the root-level generic bus class every NASDK component can `new`.
 *
 * It is a shared IMPLEMENTATION, not a shared INSTANCE. Each part news its own bus and owns an
 * independent event pipeline: the NApp communication stack (NACP + NACT + NApp 门面) shares ONE instance
 * created with the NApp (carries `nacp:*`; NACT reports physical connect/disconnect onto it), while
 * NACEB news its own separate instance (carries `naceb:*`). NACEB uses this class precisely so it
 * needn't hand-roll a bus — same code, different instance. So "who uses EventBus" is everyone; the
 * boundary is which instance, not whether.
 *
 * Colon-segmented keys (`a:b:c`); a subscription segment of `*` matches any single
 * segment (`a:*:c`). Generic — does not assume NACEB's `naceb:layer:state:phase:id`.
 *
 * Dispatch is O(number-of-distinct-wildcard-shapes), not O(total-subscriptions):
 * every subscription is bucketed by (segment count + wildcard mask + the literal
 * segments). On emit we only iterate the distinct shapes ever registered (a small
 * constant in practice — full-`*`, tail-`*`, exact, …) and hash-lookup each bucket.
 *
 * emit() is a read-only observation fan-out: a throwing/rejecting listener is
 * isolated (routed to onError), never propagated back to the caller. This is the
 * whole reason for hand-rolling instead of EventEmitter, whose native name-keyed
 * index cannot express `a:*:c` and whose emit aborts remaining listeners on throw.
 *
 * A holder owns a bus (news it, emits on it internally) and exposes `bus.readonly`
 * (a ReadonlyBus: subscribe/unsubscribe only, no emit) to the outside — so observers
 * can listen but never forge events. Internally the holder uses the full bus directly.
 */

import { uid } from './utils/id.ts'

type Sub = { id: string; cb: (p: any, hitKey: string) => unknown; once: boolean }
type Shape = { len: number; mask: boolean[] }   // mask[i] = true ⟺ that segment is '*'

/**
 * Read-only Proxy over a live instance, handed to observers as the `this` of a T-event (transition)
 * callback. Reads透传 (fields, getters, and methods all pass through — a method call rebinds `this`
 * back to the real target so consume()/start() still work); writes throw. The observation surface is
 * read-only by contract (「naceb 事件内不得修改内容」): an observer may inspect and may call methods,
 * but may not mutate framework state (this.status = ... etc.) — that stays the exclusive province of
 * the state machine itself. The real instance is never frozen (the FSM must keep writing status), so
 * the immutability is per-dispatch, enforced by this view rather than on the object.
 */
export function readonlyView<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, p, _r) {
      const v = (t as any)[p]
      return typeof v === 'function' ? v.bind(t) : v   // method → bound to real target; field/getter → value
    },
    set(_t, p) { throw new TypeError(`readonly: cannot assign '${String(p)}' — naceb 事件内不得修改内容`) },
    defineProperty(_t, p) { throw new TypeError(`readonly: cannot defineProperty '${String(p)}' — naceb 事件内不得修改内容`) },
    deleteProperty(_t, p) { throw new TypeError(`readonly: cannot delete '${String(p)}' — naceb 事件内不得修改内容`) },
  })
}

/** Read-only observation view of an EventBus: subscribe/unsubscribe only, no emit. A holder that owns a
 *  bus (news it, emits on it internally) exposes this to the outside so observers can listen but never
 *  forge events. `bus.readonly` returns one; holders re-export it (e.g. NACEB.eventBusObs). */
export interface ReadonlyBus {
  /** Subscribe; returns the subscription id to pass to off(). The same cb may be registered many times —
   *  each call is an independent subscription with its own id. `hitKey` is the concrete key that fired, which
   *  is the only way a wildcard subscriber can tell which event it actually caught. */
  listen(key: string, cb: (p: any, hitKey: string) => void): string
  /** Subscribe for one dispatch, then auto-remove. Returns an id too, for cancelling before it fires. */
  listenOnce(key: string, cb: (p: any, hitKey: string) => void): string
  /** await one event. With `cb`, its `this` is the emit-side thisArg (readonlyView for T-events, the bus
   *  otherwise) and its return value resolves the promise; a throw/rejection rejects it. Without `cb`,
   *  resolves with the payload. */
  asyncListenOnce<R = any>(key: string, cb?: (this: any, p: any) => R | Promise<R>): Promise<R>
  /** Cancel by subscription id (the value listen/listenOnce returned). Returns true if one was removed. */
  off(id: string): boolean
}

export class EventBus {
  // bucketKey → subs. bucketKey = `${len}\x1f${maskBits}\x1f${literalSegmentsJoined}`.
  private buckets = new Map<string, Sub[]>()
  // Distinct wildcard shapes seen so far; emit iterates only these.
  private shapes: Shape[] = []
  private maxListeners = 50
  /** listener-error sink. Defaults to a no-op; a holder should override it (e.g. re-emit as its own
   *  runtime:error event). Also used for the maxListeners warning. */
  onError: (key: string, err: unknown) => void = () => {}

  private shapeOf(pattern: string[]): Shape {
    return { len: pattern.length, mask: pattern.map(seg => seg === '*') }
  }
  private maskBits(mask: boolean[]): string {
    return mask.map(b => (b ? '1' : '0')).join('')
  }
  /** Bucket key from a pattern's own literals (used at subscribe time). */
  private keyFromPattern(pattern: string[], shape: Shape): string {
    const lits = pattern.filter((_, i) => !shape.mask[i]).join(':')
    return `${shape.len}\x1f${this.maskBits(shape.mask)}\x1f${lits}`
  }
  /** Bucket key from a concrete emitted key, viewed through a given shape. */
  private keyFromParts(parts: string[], shape: Shape): string {
    const lits = parts.filter((_, i) => !shape.mask[i]).join(':')
    return `${shape.len}\x1f${this.maskBits(shape.mask)}\x1f${lits}`
  }
  private registerShape(shape: Shape) {
    if (!this.shapes.some(s => s.len === shape.len && this.maskBits(s.mask) === this.maskBits(shape.mask)))
      this.shapes.push(shape)
  }

  private add(key: string, cb: (p: any, hitKey: string) => void, once: boolean): string {
    const pattern = key.split(':')
    const shape = this.shapeOf(pattern)
    this.registerShape(shape)
    const bk = this.keyFromPattern(pattern, shape)
    const arr = this.buckets.get(bk) ?? this.buckets.set(bk, []).get(bk)!
    const id = uid('sub')
    arr.push({ id, cb, once })
    if (arr.length > this.maxListeners)
      this.onError(key, new Error(`EventBus: ${arr.length} listeners on '${key}' — possible leak`))
    return id
  }

  /** Subscribe. Returns the subscription id — keep it to `off()` later. Registering the same cb twice
   *  yields two independent subscriptions (two ids), and both fire. */
  listen(key: string, cb: (p: any, hitKey: string) => void): string { return this.add(key, cb, false) }
  /** Subscribe for exactly one dispatch, then auto-remove. The id is still returned so the subscription
   *  can be cancelled before it ever fires. */
  listenOnce(key: string, cb: (p: any, hitKey: string) => void): string { return this.add(key, cb, true) }
  /**
   * Await a single event. The optional `cb` runs with the SAME `this` as any other listener (the emit-side
   * thisArg — a readonlyView for T-events, this bus otherwise), and **its return value resolves the
   * promise** — so `function(){ return this.status }` works. If `cb` throws (or returns a rejecting
   * promise) the returned promise REJECTS: unlike a fan-out listener, an awaited one has a caller to
   * report to, so the error goes to that caller instead of being swallowed into onError.
   * Without `cb`, resolves with the payload (`this` unreachable — pass a `function` cb to read it).
   */
  asyncListenOnce<R = any>(key: string, cb?: (this: any, p: any) => R | Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.listenOnce(key, function (this: any, payload: any) {
        if (!cb) return resolve(payload as R)
        // The wrapper absorbs the error (turning it into reject), so emit()'s isolation never sees it:
        // an awaited listener has a caller to report to, and that caller is the single authoritative sink.
        try {
          const r = cb.call(this, payload)
          if (r && typeof (r as any).then === 'function') {
            return (r as Promise<R>).then(resolve, reject)
          }
          resolve(r as R)
        } catch (e) { reject(e) }
      })
    })
  }

  /** Cancel a subscription by the id `listen`/`listenOnce` returned. Returns whether one was removed
   *  (false = already fired-and-removed, or already off'd, or never existed). */
  off(id: string): boolean {
    for (const arr of this.buckets.values()) {
      const i = arr.findIndex(s => s.id === id)
      if (i >= 0) { arr.splice(i, 1); return true }
    }
    return false
  }

  /** Read-only view of this bus (subscribe/unsubscribe only, no emit). Holders expose this to observers
   *  so they can listen but never emit. The view forwards to this same instance — no copy, no new bus. */
  get readonly(): ReadonlyBus {
    return {
      listen:          (k, cb) => this.listen(k, cb),
      listenOnce:      (k, cb) => this.listenOnce(k, cb),
      asyncListenOnce: (k, cb) => this.asyncListenOnce(k, cb),
      off:             (id)    => this.off(id),
    }
  }

  /**
   * Fan out to matching observers. `thisArg` (optional) becomes the observer callback's `this`.
   * When omitted, `this` defaults to the EventBus instance itself (convention with Node EventEmitter).
   * NACEB/NACAB T-events pass `readonlyView(instance)` to override — the observer written as
   * `function(){ this.status }` reads state off the instance, symmetric with hook's `fn.call(instance)`.
   * Runtime events (no thisArg passed) default to EventBus as `this`. Errors stay isolated to onError.
   *
   * The callback's SECOND argument is the concrete key that fired. It exists for wildcard subscribers: a
   * listener on `job:*` otherwise cannot tell `job:done` from `job:failed`, because the pattern it registered
   * is all it has. Locally that is merely inconvenient; across a process boundary it is lost information, which
   * is why NACP's notify carries both the subscribed pattern and the hit key — and it can only fill the latter
   * because this argument exists.
   */
  emit(key: string, payload: any, thisArg?: any) {
    const parts = key.split(':')
    // Collect matching subs across every distinct shape (each is one hash lookup).
    const hit: { bucket: Sub[]; sub: Sub }[] = []
    for (const shape of this.shapes) {
      if (shape.len !== parts.length) continue
      const bucket = this.buckets.get(this.keyFromParts(parts, shape))
      if (bucket) for (const sub of bucket) hit.push({ bucket, sub })
    }
    for (const { bucket, sub } of hit) if (sub.once) { const i = bucket.indexOf(sub); if (i >= 0) bucket.splice(i, 1) }
    // Read-only observation: listener errors are isolated, never fed back to the state machine (P0-2).
    for (const { sub } of hit) {
      try {
        const r = sub.cb.call(thisArg !== undefined ? thisArg : this, payload, key)
        if (r && typeof (r as any).then === 'function') (r as Promise<any>).catch(e => this.onError(key, e))
      } catch (e) { this.onError(key, e) }
    }
  }
}
