import type { NACTPeerId } from '../NACT/types.ts'
import type { NACPMessage, NotifyMessage, ResponseMessage } from './types.ts'
import { nacpInbound } from './errors.ts'

export type AppLinkState = 'online' | 'offline'

export interface OfflineSnapshot {
  peerId: NACTPeerId
  gatewayPeerId?: NACTPeerId
  gatewayAppId?: string               // identity is by appId, not string match
}

export interface AppLinkRecord {
  peerId: NACTPeerId
  state: AppLinkState
  snapshot?: OfflineSnapshot
}

export class PeerAppConnectionTable {
  private appIdPeerSheet = new Map<string, AppLinkRecord>()
  private _gatewayPeerId?: NACTPeerId
  private _gatewayAppId?: string

  bind(appId: string, peerId: NACTPeerId) { this.appIdPeerSheet.set(appId, { peerId, state: 'online' }) }

  setGateway(peerId: NACTPeerId, appId: string): boolean {
    if (this._gatewayPeerId !== undefined && this._gatewayPeerId !== peerId) return false
    this._gatewayPeerId = peerId
    this._gatewayAppId = appId
    return true
  }

  hasGateway(): boolean { return this._gatewayPeerId !== undefined }

  /** Undefined if unknown or already offline — the first snapshot wins. */
  markOffline(appId: string): OfflineSnapshot | undefined {
    const rec = this.appIdPeerSheet.get(appId)
    if (!rec || rec.state === 'offline') return undefined
    rec.state = 'offline'
    rec.snapshot = { peerId: rec.peerId, gatewayPeerId: this._gatewayPeerId, gatewayAppId: this._gatewayAppId }
    return rec.snapshot
  }

  getState(appId: string): AppLinkState | undefined { return this.appIdPeerSheet.get(appId)?.state }
  getSnapshot(appId: string): OfflineSnapshot | undefined { return this.appIdPeerSheet.get(appId)?.snapshot }
  isOnline(appId: string): boolean { return this.appIdPeerSheet.get(appId)?.state === 'online' }

  deleteAppIdbyAppId(appId: string) {
    const rec = this.appIdPeerSheet.get(appId)
    if (rec !== undefined && this._gatewayAppId === appId) { this._gatewayPeerId = undefined; this._gatewayAppId = undefined }
    this.appIdPeerSheet.delete(appId)
  }

  listAppIdbyPeerId(peerId: NACTPeerId): string[] {
    const out: string[] = []
    for (const [appId, rec] of this.appIdPeerSheet) if (rec.peerId === peerId) out.push(appId)
    return out
  }

  deleteAppIdbyPeerId(peerId: NACTPeerId): string[] {
    const appIds = this.listAppIdbyPeerId(peerId)
    for (const appId of appIds) this.appIdPeerSheet.delete(appId)
    if (this._gatewayPeerId === peerId) { this._gatewayPeerId = undefined; this._gatewayAppId = undefined }
    return appIds
  }

  getPeerIdbyAppId(appId: string): NACTPeerId | undefined { return this.appIdPeerSheet.get(appId)?.peerId }

  has(appId: string): boolean { return this.appIdPeerSheet.has(appId) }
  listAppId(): string[] { return [...this.appIdPeerSheet.keys()] }
  listOnlineAppId(): string[] {
    const out: string[] = []
    for (const [appId, rec] of this.appIdPeerSheet) if (rec.state === 'online') out.push(appId)
    return out
  }
  getGatewayPeerId(): NACTPeerId | undefined { return this._gatewayPeerId }
  getGatewayAppId(): string | undefined { return this._gatewayAppId }
  clear() { this.appIdPeerSheet.clear(); this._gatewayPeerId = undefined; this._gatewayAppId = undefined }
}

// ── ResponsePendingTable ────────────────────────────────────────────────────

export interface PendingEntry {
  resolve: (r: ResponseMessage) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined   // undefined = no timeout (request)
  destAppId: string
}

export class ResponsePendingTable {
  private msgIdPendingSheet = new Map<string, PendingEntry>()

  add(msgId: string, entry: PendingEntry) { this.msgIdPendingSheet.set(msgId, entry) }

  getPendingEntrybyMsgId(msgId: string): PendingEntry | undefined { return this.msgIdPendingSheet.get(msgId) }

  settle(parentId: string): PendingEntry | undefined {
    const e = this.msgIdPendingSheet.get(parentId)
    if (e) { clearTimeout(e.timer); this.msgIdPendingSheet.delete(parentId) }
    return e
  }

  /** Only at full cleanup (grace expiry / goodbye) — a returning peer replays its answers. */
  failFor(appId: string, reason: string) {
    for (const [id, e] of this.msgIdPendingSheet) {
      if (e.destAppId !== appId) continue
      clearTimeout(e.timer)
      e.reject(nacpInbound('peer-gone', reason))
      this.msgIdPendingSheet.delete(id)
    }
  }

  failAll(reason: string) {
    for (const [id, e] of this.msgIdPendingSheet) {
      clearTimeout(e.timer)
      e.reject(nacpInbound('terminate', reason))
      this.msgIdPendingSheet.delete(id)
    }
  }

  has(msgId: string): boolean { return this.msgIdPendingSheet.has(msgId) }
  hasFor(appId: string): boolean {
    for (const entry of this.msgIdPendingSheet.values()) if (entry.destAppId === appId) return true
    return false
  }
  size(): number { return this.msgIdPendingSheet.size }
}

// ── SubscribeTable ──────────────────────────────────────────────────────────

/** subId → record; read only at teardown (off its listenId). */
export interface SubRecord {
  subId: string
  appId: string
  listenId: string
  targetSubName: string
}

export class SubscribeTable {
  private subIdSubscribeSheet = new Map<string, SubRecord>()

  add(rec: SubRecord) { this.subIdSubscribeSheet.set(rec.subId, rec) }

  getSubRecordbySubId(subId: string): SubRecord | undefined { return this.subIdSubscribeSheet.get(subId) }

  deleteSubRecordbySubId(subId: string): SubRecord | undefined {
    const rec = this.subIdSubscribeSheet.get(subId)
    if (rec) this.subIdSubscribeSheet.delete(subId)
    return rec
  }

  deleteSubRecordbyAppId(appId: string): SubRecord[] {
    const out: SubRecord[] = []
    for (const rec of this.subIdSubscribeSheet.values()) if (rec.appId === appId) out.push(rec)
    for (const rec of out) this.subIdSubscribeSheet.delete(rec.subId)
    return out
  }

  listSubRecord(): SubRecord[] { return [...this.subIdSubscribeSheet.values()] }

  clear() { this.subIdSubscribeSheet.clear() }
  size(): number { return this.subIdSubscribeSheet.size }
}

// ── ListenTable ─────────────────────────────────────────────────────────────

export interface ListenRecord {
  subId: string
  appId: string
  targetSubName: string
  targetListener: (payload: any, msg: NotifyMessage) => void
  onEnd?: () => void
}

export class ListenTable {
  private subIdListenSheet = new Map<string, ListenRecord>()

  add(rec: ListenRecord) { this.subIdListenSheet.set(rec.subId, rec) }

  getListenRecordbySubId(subId: string): ListenRecord | undefined { return this.subIdListenSheet.get(subId) }

  /** All removal paths funnel through here so onEnd fires exactly once. */
  private end(rec: ListenRecord) {
    if (!rec.onEnd) return
    const fn = rec.onEnd
    rec.onEnd = undefined
    try { fn() } catch { /* consumer cleanup must not derail ours */ }
  }

  deleteListenRecordbySubId(subId: string): ListenRecord | undefined {
    const rec = this.subIdListenSheet.get(subId)
    if (rec) { this.subIdListenSheet.delete(subId); this.end(rec) }
    return rec
  }

  deleteListenRecordbyAppId(appId: string): ListenRecord[] {
    const out: ListenRecord[] = []
    for (const rec of this.subIdListenSheet.values()) if (rec.appId === appId) out.push(rec)
    for (const rec of out) { this.subIdListenSheet.delete(rec.subId); this.end(rec) }
    return out
  }

  clear() {
    const all = [...this.subIdListenSheet.values()]
    this.subIdListenSheet.clear()
    for (const rec of all) this.end(rec)
  }
  size(): number { return this.subIdListenSheet.size }
}

// ── the three ack-round-trip tables ─────────────────────────────────────────

export function measureBytes(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 1
  if (depth > 8) return 64
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  switch (typeof value) {
    case 'string':  return value.length * 2
    case 'number':  return 8
    case 'boolean': return 1
    case 'bigint':  return 16
    case 'object': {
      if (Array.isArray(value)) {
        let n = 8
        for (const v of value) n += measureBytes(v, depth + 1)
        return n
      }
      let n = 8
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) n += k.length * 2 + measureBytes(v, depth + 1)
      return n
    }
    default: return 8
  }
}

export interface OutboundRecord {
  msg: NACPMessage
  destAppId: string
  bytes: number
  sentOnce: boolean
}

abstract class CappedOutboundQueue {
  protected sheet = new Map<string, OutboundRecord>()
  protected _bytes = 0
  protected maxBytes: number
  protected maxCount: number

  constructor(maxBytes: number, maxCount: number) {
    this.maxBytes = maxBytes
    this.maxCount = maxCount
  }

  protected get overCap(): boolean { return this._bytes > this.maxBytes || this.sheet.size > this.maxCount }

  protected take(id: string): OutboundRecord | undefined {
    const rec = this.sheet.get(id)
    if (rec) { this.sheet.delete(id); this._bytes -= rec.bytes }
    return rec
  }

  get(id: string): OutboundRecord | undefined { return this.sheet.get(id) }
  has(id: string): boolean { return this.sheet.has(id) }
  delete(id: string): boolean { return this.take(id) !== undefined }

  listByAppId(appId: string): OutboundRecord[] {
    const out: OutboundRecord[] = []
    for (const rec of this.sheet.values()) if (rec.destAppId === appId) out.push(rec)
    return out
  }

  deleteByAppId(appId: string): OutboundRecord[] {
    const out = this.listByAppId(appId)
    for (const rec of out) this.take(rec.msg.id)
    return out
  }

  clear(): OutboundRecord[] {
    const all = [...this.sheet.values()]
    this.sheet.clear()
    this._bytes = 0
    return all
  }

  size(): number { return this.sheet.size }
  bytes(): number { return this._bytes }
}

// ── OutboundBacklogTable ────────────────────────────────────────────────────

/** What a cap forced this queue to give up, and which rule did it. */
export interface BacklogEviction {
  rec: OutboundRecord
  reason: 'notify-dropped' | 'notify-evicted' | 'fifo-evicted'
}

export class OutboundBacklogTable extends CappedOutboundQueue {
  add(rec: OutboundRecord): BacklogEviction[] {
    const arrivalIsNotify = rec.msg.type === 'notify'
    this.sheet.set(rec.msg.id, rec)
    this._bytes += rec.bytes
    if (!this.overCap) return []

    // Tier 1: drop the arriving notify.
    if (arrivalIsNotify) {
      this.take(rec.msg.id)
      return [{ rec, reason: 'notify-dropped' }]
    }

    const out: BacklogEviction[] = []
    // Tier 2 then tier 3: spend every notify first, only then reliable traffic.
    for (const reason of ['notify-evicted', 'fifo-evicted'] as const) {
      for (const [id, r] of this.sheet) {
        if (!this.overCap) return out
        if (id === rec.msg.id) continue
        if (reason === 'notify-evicted' && r.msg.type !== 'notify') continue
        this.take(id)
        out.push({ rec: r, reason })
      }
    }
    return out
  }

  /** Put records back at the FRONT of the queue (preserves their original wire order). */
  unshiftAll(recs: OutboundRecord[]) {
    if (recs.length === 0) return
    const existing = [...this.sheet]
    this.sheet.clear()
    for (const rec of recs) { this.sheet.set(rec.msg.id, rec); this._bytes += rec.bytes }
    for (const [id, rec] of existing) if (!this.sheet.has(id)) this.sheet.set(id, rec)
  }

  drainByAppId(appId: string): OutboundRecord[] { return this.deleteByAppId(appId) }
}

// ── AckPendingTable ─────────────────────────────────────────────────────────

export class AckPendingTable extends CappedOutboundQueue {
  add(rec: OutboundRecord): OutboundRecord[] {
    this.sheet.set(rec.msg.id, rec)
    this._bytes += rec.bytes

    const evicted: OutboundRecord[] = []
    for (const [id, r] of this.sheet) {
      if (!this.overCap) break
      if (id === rec.msg.id) continue     // the newcomer survives even when it alone exceeds maxBytes
      this.take(id)
      evicted.push(r)
    }
    return evicted
  }

  settle(msgId: string): OutboundRecord | undefined { return this.take(msgId) }

  /** Hand every record for one appId back to the backlog, marked sentOnce (replayed on reconnect). */
  drainByAppId(appId: string): OutboundRecord[] {
    const out = this.deleteByAppId(appId)
    for (const rec of out) rec.sentOnce = true
    return out
  }
}

// ── InboundReceivedTable ────────────────────────────────────────────────────

export class InboundReceivedTable {
  private msgIdSeenSheet = new Map<string, string>()   // message id → source appId
  private maxCount: number

  constructor(maxCount: number) { this.maxCount = maxCount }

  add(msgId: string, fromAppId: string) {
    this.msgIdSeenSheet.set(msgId, fromAppId)
    for (const id of this.msgIdSeenSheet.keys()) {
      if (this.msgIdSeenSheet.size <= this.maxCount) break
      if (id === msgId) continue
      this.msgIdSeenSheet.delete(id)
    }
  }

  has(msgId: string): boolean { return this.msgIdSeenSheet.has(msgId) }

  deleteByAppId(appId: string) {
    for (const [id, from] of this.msgIdSeenSheet) if (from === appId) this.msgIdSeenSheet.delete(id)
  }

  clear() { this.msgIdSeenSheet.clear() }
  size(): number { return this.msgIdSeenSheet.size }
}
