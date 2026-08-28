/**
 * NASDK EventBus — the root-level generic bus class every NASDK component can `new`.
 *
 * Colon-segmented keys (`a:b:c`); a subscription segment of `*` matches any single segment (`a:*:c`).
 * Dispatch is bucketed by (segment count + wildcard mask + literal segments), so emit is
 * O(number-of-distinct-shapes) with one hash lookup each.
 *
 * emit() is a read-only observation fan-out: a throwing/rejecting listener is isolated to onError, never
 * propagated to the caller. A holder exposes `bus.readonly` (subscribe/unsubscribe only) to observers;
 * internally it uses the full bus.
 */

import { uid } from './utils/id.ts'

type Sub = { id: string; cb: (p: any, hitKey: string) => unknown; once: boolean }
type Shape = { len: number; mask: boolean[] }   // mask[i] = true ⟺ that segment is '*'

/**
 * Read-only Proxy over a live instance, handed to observers as the `this` of a T-event callback. Reads pass
 * through (methods rebind to the real target so consume()/start() still work); writes throw — observers may
 * inspect and call methods but not mutate framework state during dispatch.
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

/** Read-only observation view of an EventBus: subscribe/unsubscribe only, no emit (`bus.readonly`). */
export interface ReadonlyBus {
  /** Returns a subscription id; same cb may be registered many times (independent ids). `hitKey` is the
   *  concrete key that fired — how a wildcard subscriber knows which event it caught. */
  listen(key: string, cb: (p: any, hitKey: string) => void): string
  listenOnce(key: string, cb: (p: any, hitKey: string) => void): string
  /** await one event. With `cb`, its `this` is the emit-side thisArg and its return value resolves the
   *  promise; a throw/rejection rejects it. Without `cb`, resolves with the payload. */
  asyncListenOnce<R = any>(key: string, cb?: (this: any, p: any) => R | Promise<R>): Promise<R>
  off(id: string): boolean
}

export class EventBus {
  // bucketKey → subs. bucketKey = `${len}\x1f${maskBits}\x1f${literalSegmentsJoined}`.
  private buckets = new Map<string, Sub[]>()
  // Distinct wildcard shapes seen so far; emit iterates only these.
  private shapes: Shape[] = []
  private maxListeners = 50
  /** listener-error sink; a holder should override it (e.g. re-emit as its own runtime:error event). */
  onError: (key: string, err: unknown) => void = () => {}

  private shapeOf(pattern: string[]): Shape {
    return { len: pattern.length, mask: pattern.map(seg => seg === '*') }
  }
  private maskBits(mask: boolean[]): string {
    return mask.map(b => (b ? '1' : '0')).join('')
  }
  /** Bucket key from a pattern's own literals (subscribe time). */
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

  listen(key: string, cb: (p: any, hitKey: string) => void): string { return this.add(key, cb, false) }
  listenOnce(key: string, cb: (p: any, hitKey: string) => void): string { return this.add(key, cb, true) }
  /**
   * Await a single event. The optional `cb` runs with the emit-side thisArg and its return value resolves
   * the promise (`function(){ return this.status }` works). A cb throw/rejection REJECTS — an awaited
   * listener has a caller to report to. Without `cb`, resolves with the payload.
   */
  asyncListenOnce<R = any>(key: string, cb?: (this: any, p: any) => R | Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.listenOnce(key, function (this: any, payload: any) {
        if (!cb) return resolve(payload as R)
        // Absorb the error into reject so emit()'s isolation never sees it.
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

  /** Cancel a subscription by id; false = already removed or never existed. */
  off(id: string): boolean {
    for (const arr of this.buckets.values()) {
      const i = arr.findIndex(s => s.id === id)
      if (i >= 0) { arr.splice(i, 1); return true }
    }
    return false
  }

  /** Read-only view of this bus; forwards to this same instance. */
  get readonly(): ReadonlyBus {
    return {
      listen:          (k, cb) => this.listen(k, cb),
      listenOnce:      (k, cb) => this.listenOnce(k, cb),
      asyncListenOnce: (k, cb) => this.asyncListenOnce(k, cb),
      off:             (id)    => this.off(id),
    }
  }

  /**
   * Fan out to matching observers. `thisArg` (optional) becomes the callback's `this`; NACEB/NACAB T-events
   * pass `readonlyView(instance)`. The callback's SECOND argument is the concrete key that fired — how a
   * wildcard subscriber tells `job:done` from `job:failed`.
   */
  emit(key: string, payload: any, thisArg?: any) {
    const parts = key.split(':')
    const hit: { bucket: Sub[]; sub: Sub }[] = []
    for (const shape of this.shapes) {
      if (shape.len !== parts.length) continue
      const bucket = this.buckets.get(this.keyFromParts(parts, shape))
      if (bucket) for (const sub of bucket) hit.push({ bucket, sub })
    }
    for (const { bucket, sub } of hit) if (sub.once) { const i = bucket.indexOf(sub); if (i >= 0) bucket.splice(i, 1) }
    // Listener errors are isolated to onError.
    for (const { sub } of hit) {
      try {
        const r = sub.cb.call(thisArg !== undefined ? thisArg : this, payload, key)
        if (r && typeof (r as any).then === 'function') (r as Promise<any>).catch(e => this.onError(key, e))
      } catch (e) { this.onError(key, e) }
    }
  }
}
