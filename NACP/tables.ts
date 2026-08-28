/**
 * NACP state tables — seven standard tables. Each holds ONE Map (`sheet`) keyed the way its hot path reads
 * it; other-direction lookups scan (they run a handful of times per App lifetime).
 *
 *   PeerAppConnectionTable  — appId↔peerId link records + Gateway slot
 *   ResponsePendingTable    — outbound messages awaiting their response, keyed by message id
 *   SubscribeTable          — subscribed side: listen-id ownership roster (teardown off)
 *   ListenTable             — subscribing side: inbound notify → local handler
 *   OutboundBacklogTable    — outbound stage 1: held while the destination is offline
 *   AckPendingTable         — outbound stage 2: sent, waiting for ack
 *   InboundReceivedTable    — inbound dedup: ids already handled
 */

import type { NACTPeerId } from '../NACT/types.ts'
import type { NACPMessage, NotifyMessage, ResponseMessage } from './types.ts'
import { nacpInbound } from './errors.ts'

// ── PeerAppConnectionTable ──────────────────────────────────────────────────

/** Reachability of one known App. `offline` = known + unreachable + on the grace clock. */
export type AppLinkState = 'online' | 'offline'

/** Link view at disconnect instant, kept for the decision at grace expiry. */
export interface OfflineSnapshot {
  peerId: NACTPeerId                  // the peer this appId was reached through
  gatewayPeerId?: NACTPeerId          // the Gateway slot's holder at that instant
  gatewayAppId?: string               // which appId held it — a Gateway's name is arbitrary, so identity is by appId, not by string match
}

export interface AppLinkRecord {
  peerId: NACTPeerId
  state: AppLinkState
  snapshot?: OfflineSnapshot          // present iff state === 'offline'
}

export class PeerAppConnectionTable {
  private appIdPeerSheet = new Map<string, AppLinkRecord>()
  /** Outbound fallback peer; first-come-first-served via setGateway(). */
  private _gatewayPeerId?: NACTPeerId
  /** Which appId holds the Gateway slot (several appIds may share the Gateway's peerId). */
  private _gatewayAppId?: string

  bind(appId: string, peerId: NACTPeerId) { this.appIdPeerSheet.set(appId, { peerId, state: 'online' }) }

  /** Claim the Gateway slot; false when another peer holds it. */
  setGateway(peerId: NACTPeerId, appId: string): boolean {
    if (this._gatewayPeerId !== undefined && this._gatewayPeerId !== peerId) return false
    this._gatewayPeerId = peerId
    this._gatewayAppId = appId
    return true
  }

  hasGateway(): boolean { return this._gatewayPeerId !== undefined }

  /** Mark unreachable + snapshot; undefined if unknown or already offline (first snapshot wins). */
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

  /** All appIds on one peer (a Gateway relay shares its peerId). */
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
  timer: ReturnType<typeof setTimeout> | undefined   // undefined for request (no timeout)
  destAppId: string                       // for bulk-fail when that peer goes away
}

export class ResponsePendingTable {
  private msgIdPendingSheet = new Map<string, PendingEntry>()

  add(msgId: string, entry: PendingEntry) { this.msgIdPendingSheet.set(msgId, entry) }

  /** Peek without settling (notify is a push, not the terminal). */
  getPendingEntrybyMsgId(msgId: string): PendingEntry | undefined { return this.msgIdPendingSheet.get(msgId) }

  /** Take the waiter and clear its timer; only the terminal response settles an entry. */
  settle(parentId: string): PendingEntry | undefined {
    const e = this.msgIdPendingSheet.get(parentId)
    if (e) { clearTimeout(e.timer); this.msgIdPendingSheet.delete(parentId) }
    return e
  }

  /** Reject everything bound for one appId. Called only at full cleanup (grace expiry / goodbye), never on
   *  bare disconnect — a returning peer replays its answers. */
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

/** One active subscription = one listener this NACP registered on its own bus on a peer's behalf. */
export interface SubRecord {
  subId: string           // the subscribe message's id (or the reqId, for an auto-subscription)
  appId: string           // the subscriber — where matching notifies are sent
  listenId: string        // the local EventBus subscription id, so unsubscribe/disconnect can `off` it
  targetSubName: string   // the subscribed name (may contain a single-segment `*`); echoed in NotifyMeta
}

/** Listen-id ownership roster, read only at teardown (unsubscribe / peer vanished → off its listenId). */
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

/** One active listen = one local handler for the notifies of a subscription THIS App requested. */
export interface ListenRecord {
  subId: string           // the same id the subscribed side files under
  appId: string           // the peer we subscribed ON
  targetSubName: string   // what we asked for (may contain a single-segment `*`)
  targetListener: (payload: any, msg: NotifyMessage) => void   // always present; omitting means () => {}
  /** Called once when this record leaves the table, whatever removed it. */
  onEnd?: () => void
}

/** Subscribing side's half of a subscription: inbound notify → handler, matched by parentId. */
export class ListenTable {
  private subIdListenSheet = new Map<string, ListenRecord>()

  add(rec: ListenRecord) { this.subIdListenSheet.set(rec.subId, rec) }

  getListenRecordbySubId(subId: string): ListenRecord | undefined { return this.subIdListenSheet.get(subId) }

  /** Fire a removed record's onEnd exactly once; every removal path funnels through here. */
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

/** Approximate byte cost of a value for queue caps: Buffers exact, everything else estimated.
 *  Depth-limited against pathological payloads. */
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

/** One queued outbound message in either outbound table. */
export interface OutboundRecord {
  msg: NACPMessage
  destAppId: string
  bytes: number         // charge against the byte cap
  sentOnce: boolean     // already reached the wire once, awaiting replay
}

/** Shared cap bookkeeping for the two outbound queues. Insertion order IS eviction order (Map iteration).
 *  A record larger than maxBytes still gets admitted as sole occupant. */
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

/**
 * Outbound stage 1: held while the destination is offline; pass-through while online. Keyed by message id,
 * grouped by DESTINATION appId (clearing rules are per-App).
 *
 * Overflow tiers: 1) arriving notify → drop the arrival; 2) evict oldest notifies; 3) plain FIFO.
 */
export class OutboundBacklogTable extends CappedOutboundQueue {
  /** Admit one message and settle the caps; returns what was given up. */
  add(rec: OutboundRecord): BacklogEviction[] {
    const arrivalIsNotify = rec.msg.type === 'notify'
    this.sheet.set(rec.msg.id, rec)
    this._bytes += rec.bytes
    if (!this.overCap) return []

    // Tier 1
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

/** Outbound stage 2: sent, waiting for ack; keyed by message id (= ack's meta.parentId). Notify/ack never
 *  enter. No retry counter: timeout → App offline → replay on reconnect. */
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

/** Inbound dedup: ids already handled → handle once, ack every time. Without it a replayed response would
 *  falsely report has-no-consumer. Notify/ack get no record (never replayed). */
export class InboundReceivedTable {
  private msgIdSeenSheet = new Map<string, string>()   // message id → source appId
  private maxCount: number

  constructor(maxCount: number) { this.maxCount = maxCount }

  /** Record an id as handled, evicting oldest-first past the count cap. */
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
