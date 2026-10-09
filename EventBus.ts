import { uid } from './utils/id.ts'

type Sub = { id: string; cb: (p: any, hitKey: string) => unknown; once: boolean }
type Shape = { len: number; mask: boolean[] }   // mask[i] true ⟺ segment i is '*'

export function readonlyView<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, p, _r) {
      const v = (t as any)[p]
      return typeof v === 'function' ? v.bind(t) : v
    },
    set(_t, p) { throw new TypeError(`readonly: cannot assign '${String(p)}' — naceb 事件内不得修改内容`) },
    defineProperty(_t, p) { throw new TypeError(`readonly: cannot defineProperty '${String(p)}' — naceb 事件内不得修改内容`) },
    deleteProperty(_t, p) { throw new TypeError(`readonly: cannot delete '${String(p)}' — naceb 事件内不得修改内容`) },
  })
}

export interface ReadonlyBus {
  listen(key: string, cb: (p: any, hitKey: string) => void): string
  listenOnce(key: string, cb: (p: any, hitKey: string) => void): string
  asyncListenOnce<R = any>(key: string, cb?: (this: any, p: any) => R | Promise<R>): Promise<R>
  off(id: string): boolean
}

export class EventBus {
  // bucketKey → subs. bucketKey = `${len}\x1f${maskBits}\x1f${literalSegmentsJoined}`.
  private buckets = new Map<string, Sub[]>()
  private shapes: Shape[] = []
  private maxListeners = 50
  onError: (key: string, err: unknown) => void = () => {}

  private shapeOf(pattern: string[]): Shape {
    return { len: pattern.length, mask: pattern.map(seg => seg === '*') }
  }
  private maskBits(mask: boolean[]): string {
    return mask.map(b => (b ? '1' : '0')).join('')
  }
  private keyFromPattern(pattern: string[], shape: Shape): string {
    const lits = pattern.filter((_, i) => !shape.mask[i]).join(':')
    return `${shape.len}\x1f${this.maskBits(shape.mask)}\x1f${lits}`
  }
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
  asyncListenOnce<R = any>(key: string, cb?: (this: any, p: any) => R | Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.listenOnce(key, function (this: any, payload: any) {
        if (!cb) return resolve(payload as R)
        // Absorb into reject so emit()'s listener isolation never sees it.
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

  off(id: string): boolean {
    for (const arr of this.buckets.values()) {
      const i = arr.findIndex(s => s.id === id)
      if (i >= 0) { arr.splice(i, 1); return true }
    }
    return false
  }

  get readonly(): ReadonlyBus {
    return {
      listen:          (k, cb) => this.listen(k, cb),
      listenOnce:      (k, cb) => this.listenOnce(k, cb),
      asyncListenOnce: (k, cb) => this.asyncListenOnce(k, cb),
      off:             (id)    => this.off(id),
    }
  }

  emit(key: string, payload: any, thisArg?: any) {
    const parts = key.split(':')
    const hit: { bucket: Sub[]; sub: Sub }[] = []
    for (const shape of this.shapes) {
      if (shape.len !== parts.length) continue
      const bucket = this.buckets.get(this.keyFromParts(parts, shape))
      if (bucket) for (const sub of bucket) hit.push({ bucket, sub })
    }
    for (const { bucket, sub } of hit) if (sub.once) { const i = bucket.indexOf(sub); if (i >= 0) bucket.splice(i, 1) }
    for (const { sub } of hit) {
      try {
        const r = sub.cb.call(thisArg !== undefined ? thisArg : this, payload, key)
        if (r && typeof (r as any).then === 'function') (r as Promise<any>).catch(e => this.onError(key, e))
      } catch (e) { this.onError(key, e) }
    }
  }
}
