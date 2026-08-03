/**
 * NACP state tables — three connection-level tables. Each does FORWARD lookup and connection bookkeeping
 * only; none builds a reverse index. That restraint is the point: fan-out on a hit is EventBus's job (its
 * bucketed wildcard index already is that index), so duplicating it here would be a second, drifting copy.
 *
 *   PeerAppConnectionTable  — appId↔peerId. Built by the register handshake. NACP's one irreducible table:
 *                             EventBus knows event names, not which physical connection an appId sits on.
 *   ResponsePendingTable    — in-flight request/register/unregister awaiting their response, keyed by that
 *                             message's id, with a timeout timer and bulk-fail by destination appId.
 *   SubscribeTable          — subId → { appId, listenId, targetSubName }. NOT a subscription reverse index:
 *                             it is a LISTEN-ID OWNERSHIP ROSTER, so a disconnect can `off` everything one
 *                             peer registered on the local bus.
 *
 * What was deliberately dissolved: the old `_relayTable` / `autoSubscriptions` per-request routing state
 * ("remember where each request came from"). Since every App has exactly ONE connection to the Gateway
 * (browser multi-tab and friends are multiplexed INSIDE that App), a reply only needs the packet's own `to`.
 */

import type { NACTPeerId } from '../NACT/types.ts'
import type { ResponseMessage } from './types.ts'
import { nacpInbound } from './errors.ts'

// ── PeerAppConnectionTable ──────────────────────────────────────────────────

export class PeerAppConnectionTable {
  private byApp = new Map<string, NACTPeerId>()
  private byPeer = new Map<NACTPeerId, string>()
  /** The peer that declared itself a Gateway (register / accept-response isGateway:true). Outbound falls
   *  back to it when there is no direct connection to the destination. */
  private _gatewayPeerId?: NACTPeerId

  bind(appId: string, peerId: NACTPeerId, isGateway = false) {
    this.byApp.set(appId, peerId)
    this.byPeer.set(peerId, appId)
    if (isGateway) this._gatewayPeerId = peerId
  }

  drop(appId: string) {
    const peerId = this.byApp.get(appId)
    if (peerId) {
      this.byPeer.delete(peerId)
      if (this._gatewayPeerId === peerId) this._gatewayPeerId = undefined
    }
    this.byApp.delete(appId)
  }

  dropByPeer(peerId: NACTPeerId): string | undefined {
    const appId = this.byPeer.get(peerId)
    if (appId) this.byApp.delete(appId)
    this.byPeer.delete(peerId)
    if (this._gatewayPeerId === peerId) this._gatewayPeerId = undefined
    return appId
  }

  peerId(appId: string): NACTPeerId | undefined { return this.byApp.get(appId) }
  appId(peerId: NACTPeerId): string | undefined { return this.byPeer.get(peerId) }
  has(appId: string): boolean { return this.byApp.has(appId) }
  appIds(): string[] { return [...this.byApp.keys()] }
  gatewayPeerId(): NACTPeerId | undefined { return this._gatewayPeerId }
  clear() { this.byApp.clear(); this.byPeer.clear(); this._gatewayPeerId = undefined }
}

// ── ResponsePendingTable ────────────────────────────────────────────────────

export interface PendingEntry {
  resolve: (r: ResponseMessage) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined   // undefined for request (no timeout; business call duration is unknown)
  destAppId: string                       // for bulk-fail when that peer goes away
  onProcess?: (chunk: any) => void        // auto-subscription sink: process notifies for this reqId
}

export class ResponsePendingTable {
  private byMsgId = new Map<string, PendingEntry>()

  add(msgId: string, entry: PendingEntry) { this.byMsgId.set(msgId, entry) }

  /** Peek WITHOUT settling — used by inbound notify, which is a push, not the terminal. */
  get(msgId: string): PendingEntry | undefined { return this.byMsgId.get(msgId) }

  /** Take the waiter and clear its timer. Only the terminal response settles an entry. */
  settle(parentId: string): PendingEntry | undefined {
    const e = this.byMsgId.get(parentId)
    if (e) { clearTimeout(e.timer); this.byMsgId.delete(parentId) }
    return e
  }

  /** Reject and clear everything bound for one appId (peer disconnect / inbound unregister). */
  failFor(appId: string, reason: string) {
    for (const [id, e] of this.byMsgId) {
      if (e.destAppId !== appId) continue
      clearTimeout(e.timer)
      e.reject(nacpInbound('peer-gone', reason))
      this.byMsgId.delete(id)
    }
  }

  /** Reject and clear everything (stop / shutdown). */
  failAll(reason: string) {
    for (const [id, e] of this.byMsgId) {
      clearTimeout(e.timer)
      e.reject(nacpInbound('shutdown', reason))
      this.byMsgId.delete(id)
    }
  }

  has(msgId: string): boolean { return this.byMsgId.has(msgId) }
  size(): number { return this.byMsgId.size }
}

// ── SubscribeTable ──────────────────────────────────────────────────────────

/** One active subscription = one listener this NACP registered on its own bus on a peer's behalf. */
export interface SubRecord {
  subId: string           // the subscribe message's id (or the reqId, for an auto-subscription)
  appId: string           // the subscriber — where matching notifies are sent
  listenId: string        // the local EventBus subscription id, so unsubscribe/disconnect can `off` it
  targetSubName: string   // the subscribed name (may contain a single-segment `*`); echoed in NotifyMeta
}

/**
 * The listen-id ownership roster. Two indexes, both for TEARDOWN, never for dispatch:
 *   bySub  — precise unsubscribe (targetSubId → the record → off its listenId)
 *   byApp  — a peer vanished; off everything it had registered
 * There is deliberately no by-name / by-reqId index: matching is EventBus's bucketed wildcard lookup.
 */
export class SubscribeTable {
  private bySub = new Map<string, SubRecord>()
  private byApp = new Map<string, Set<string>>()   // appId → Set<subId>

  add(rec: SubRecord) {
    this.bySub.set(rec.subId, rec)
    let s = this.byApp.get(rec.appId)
    if (!s) { s = new Set(); this.byApp.set(rec.appId, s) }
    s.add(rec.subId)
  }

  get(subId: string): SubRecord | undefined { return this.bySub.get(subId) }

  /** Remove one subscription and return it, so the caller can `off` its listenId. */
  remove(subId: string): SubRecord | undefined {
    const rec = this.bySub.get(subId)
    if (!rec) return undefined
    this.bySub.delete(subId)
    const s = this.byApp.get(rec.appId)
    if (s) { s.delete(subId); if (!s.size) this.byApp.delete(rec.appId) }
    return rec
  }

  /** Remove every subscription of one appId and return them, so the caller can `off` each listenId. */
  removeFor(appId: string): SubRecord[] {
    const s = this.byApp.get(appId)
    if (!s) return []
    const out: SubRecord[] = []
    for (const subId of s) {
      const rec = this.bySub.get(subId)
      if (rec) { out.push(rec); this.bySub.delete(subId) }
    }
    this.byApp.delete(appId)
    return out
  }

  /** Every record (used by shutdown to off all listeners). */
  all(): SubRecord[] { return [...this.bySub.values()] }

  clear() { this.bySub.clear(); this.byApp.clear() }
  size(): number { return this.bySub.size }
}
