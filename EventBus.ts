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

type Sub = { cb: (p: any) => unknown; once: boolean }
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
 *  forge events. `bus.readonly` returns one; holders re-export it (e.g. Naceb.eventBusObs). */
export interface ReadonlyBus {
  listen(key: string, cb: (p: any) => void): void
  listenOnce(key: string, cb: (p: any) => void): void
  asyncListenOnce(key: string): Promise<any>
  off(cb: (p: any) => unknown): void
}

export class EventBus {
  // bucketKey → subs. bucketKey = `${len}\x1f${maskBits}\x1f${literalSegmentsJoined}`.
  private buckets = new Map<string, Sub[]>()
  // Distinct wildcard shapes seen so far; emit iterates only these.
  private shapes: Shape[] = []
  private maxListeners = 50
  onError?: (key: string, err: unknown) => void

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

  private add(key: string, cb: (p: any) => void, once: boolean) {
    const pattern = key.split(':')
    const shape = this.shapeOf(pattern)
    this.registerShape(shape)
    const bk = this.keyFromPattern(pattern, shape)
    const arr = this.buckets.get(bk) ?? this.buckets.set(bk, []).get(bk)!
    arr.push({ cb, once })
    if (arr.length > this.maxListeners)
      this.onError?.(key, new Error(`EventBus: ${arr.length} listeners on '${key}' — possible leak`))
  }

  listen(key: string, cb: (p: any) => void) { this.add(key, cb, false) }
  listenOnce(key: string, cb: (p: any) => void) { this.add(key, cb, true) }
  asyncListenOnce(key: string): Promise<any> { return new Promise(resolve => this.listenOnce(key, resolve)) }

  off(cb: (p: any) => unknown) {
    for (const arr of this.buckets.values()) {
      const i = arr.findIndex(s => s.cb === cb)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  /** Read-only view of this bus (subscribe/unsubscribe only, no emit). Holders expose this to observers
   *  so they can listen but never emit. The view forwards to this same instance — no copy, no new bus. */
  get readonly(): ReadonlyBus {
    return {
      listen:          (k, cb) => this.listen(k, cb),
      listenOnce:      (k, cb) => this.listenOnce(k, cb),
      asyncListenOnce: (k)     => this.asyncListenOnce(k),
      off:             (cb)    => this.off(cb),
    }
  }

  /**
   * Fan out to matching observers. `thisArg` (optional) becomes the observer callback's `this` —
   * for NACEB/NACAB T-events (transitions) this is the readonlyView of the instance, so an observer
   * written as `function(){ this.status }` reads state off `this` (payload then defaults to空),
   * symmetric with the hook side's `fn.call(instance)`. Omitted (every non-transition emit) ⟹ bare
   * `cb(payload)`, `this` = undefined — behavior unchanged. Errors stay isolated to onError either way
   * (observers are read-only: they can inspect/emit-observe, never veto or feed back into the FSM).
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
        const r = sub.cb.call(thisArg, payload)
        if (r && typeof (r as any).then === 'function') (r as Promise<any>).catch(e => this.onError?.(key, e))
      } catch (e) { this.onError?.(key, e) }
    }
  }
}
