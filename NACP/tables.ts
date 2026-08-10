/**
 * NACP state tables — FOUR standard tables. Fan-out on a hit is EventBus's job (its bucketed wildcard index
 * already IS that index), so nothing here duplicates it.
 *
 * ── ONE SHEET PER TABLE, no secondary index ───────────────────────────────────────────────────────────
 * Each table holds exactly one Map — its `sheet` — keyed the way its hot path reads it. Lookups in any other
 * direction SCAN that sheet instead of maintaining a second one.
 *
 * That is deliberate. A reverse index holds no information of its own (every record already carries its own
 * appId), so it is pure derived state that add/delete must keep in sync by hand — and every such hand-written
 * sync is a leak waiting to happen. The lookups that would need it (a peer disconnected, an appId went away)
 * run a handful of times per App lifetime, over a sheet holding tens to hundreds of records. Scanning is free
 * at that frequency.
 *
 * If a scan ever does show up in a profile, the fix is a QuickSet ON the sheet — a cache the sheet itself owns
 * and invalidates — NOT a second sheet standing beside it. Two sheets is the shape that drifts.
 *
 *   PeerAppConnectionTable  — appId↔peerId. Built by the register handshake. NACP's one irreducible table:
 *                             EventBus knows event names, not which physical connection an appId sits on.
 *   ResponsePendingTable    — in-flight request/register/unregister awaiting their response, keyed by that
 *                             message's id, with a timeout timer and bulk-fail by destination appId.
 *   SubscribeTable          — subId → { appId, listenId, targetSubName }. NOT a subscription reverse index:
 *                             it is a LISTEN-ID OWNERSHIP ROSTER, so a disconnect can `off` everything one
 *                             peer registered on the local bus.
 *   ListenTable             — subId → the local listener registered when THIS App subscribed to a peer.
 *
 * ── SubscribeTable and ListenTable are the two halves of one subscription ─────────────────────────────
 * One subscription always spans two Apps, and each side keeps its own half:
 *
 *   SubscribeTable, on the SUBSCRIBED side — "who subscribed to what on my bus". Drives notify OUTBOUND:
 *     a local emit hits the forwarding listener, which packs a notify addressed to the subscriber.
 *   ListenTable, on the SUBSCRIBING side — "what did I subscribe, and who handles the arrivals". Drives
 *     notify INBOUND: an incoming notify is matched by parentId and delivered to the listener found here.
 *
 * Same key (the subId the protocol minted for that subscription), opposite directions, different processes.
 * They are mirrors, never duplicates — neither could be merged into the other.
 *
 * What was deliberately dissolved: the old `_relayTable` / `autoSubscriptions` per-request routing state
 * ("remember where each request came from"). Since every App has exactly ONE connection to the Gateway
 * (browser multi-tab and friends are multiplexed INSIDE that App), a reply only needs the packet's own `to`.
 */

import type { NACTPeerId } from '../NACT/types.ts'
import type { NotifyMessage, ResponseMessage } from './types.ts'
import { nacpInbound } from './errors.ts'

// ── PeerAppConnectionTable ──────────────────────────────────────────────────

export class PeerAppConnectionTable {
  /** The one sheet: appId → peerId. Reverse lookups scan it — see the QuickSet note at the top of the file. */
  private appIdPeerSheet = new Map<string, NACTPeerId>()
  /** The peer this App treats as its outbound fallback. Written ONLY through setGateway(), which is
   *  first-come-first-served: once taken, a second declaring peer does not silently overwrite it.
   *  Whether a peer becomes the Gateway is decided purely by that peer's own declaration
   *  (the isGateway in RegisterPayload, or in the payload of the response to it), never by a local override. */
  private _gatewayPeerId?: NACTPeerId

  bind(appId: string, peerId: NACTPeerId) { this.appIdPeerSheet.set(appId, peerId) }

  /** Claim the Gateway slot. Succeeds when the slot is free or already held by this same peer
   *  (idempotent re-register). Returns false when another peer holds it — the caller then decides
   *  between downgrading this connection or rejecting it, rather than clobbering the slot. */
  setGateway(peerId: NACTPeerId): boolean {
    if (this._gatewayPeerId !== undefined && this._gatewayPeerId !== peerId) return false
    this._gatewayPeerId = peerId
    return true
  }

  hasGateway(): boolean { return this._gatewayPeerId !== undefined }

  deleteAppIdbyAppId(appId: string) {
    const peerId = this.appIdPeerSheet.get(appId)
    if (peerId !== undefined && this._gatewayPeerId === peerId) this._gatewayPeerId = undefined
    this.appIdPeerSheet.delete(appId)
  }

  /** Scans the sheet — a peer disconnect happens a handful of times per App lifetime. */
  deleteAppIdbyPeerId(peerId: NACTPeerId): string | undefined {
    const appId = this.getAppIdbyPeerId(peerId)
    if (appId !== undefined) this.appIdPeerSheet.delete(appId)
    if (this._gatewayPeerId === peerId) this._gatewayPeerId = undefined
    return appId
  }

  getPeerIdbyAppId(appId: string): NACTPeerId | undefined { return this.appIdPeerSheet.get(appId) }

  /** Reverse direction, so it scans. Same reasoning as deleteAppIdbyPeerId. */
  getAppIdbyPeerId(peerId: NACTPeerId): string | undefined {
    for (const [appId, id] of this.appIdPeerSheet) if (id === peerId) return appId
    return undefined
  }

  has(appId: string): boolean { return this.appIdPeerSheet.has(appId) }
  listAppId(): string[] { return [...this.appIdPeerSheet.keys()] }
  getGatewayPeerId(): NACTPeerId | undefined { return this._gatewayPeerId }
  clear() { this.appIdPeerSheet.clear(); this._gatewayPeerId = undefined }
}

// ── ResponsePendingTable ────────────────────────────────────────────────────

export interface PendingEntry {
  resolve: (r: ResponseMessage) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined   // undefined for request (no timeout; business call duration is unknown)
  destAppId: string                       // for bulk-fail when that peer goes away
}

export class ResponsePendingTable {
  /** The one sheet. The key is the OUTBOUND MESSAGE's id — a reqId for a request, the subscribe message's id
   *  for a subscribe, and so on. Deliberately `MsgId`, not `ReqId`: this sheet serves every awaited type. */
  private msgIdPendingSheet = new Map<string, PendingEntry>()

  add(msgId: string, entry: PendingEntry) { this.msgIdPendingSheet.set(msgId, entry) }

  /** Peek WITHOUT settling — used by inbound notify, which is a push, not the terminal. */
  getPendingEntrybyMsgId(msgId: string): PendingEntry | undefined { return this.msgIdPendingSheet.get(msgId) }

  /** Take the waiter and clear its timer. Only the terminal response settles an entry.
   *  `e` throughout this class is a PendingEntry — NOT the `e` that means a caught error elsewhere. */
  settle(parentId: string): PendingEntry | undefined {
    const e = this.msgIdPendingSheet.get(parentId)
    if (e) { clearTimeout(e.timer); this.msgIdPendingSheet.delete(parentId) }
    return e
  }

  /** Reject and clear everything bound for one appId (peer disconnect / inbound unregister). */
  failFor(appId: string, reason: string) {
    for (const [id, e] of this.msgIdPendingSheet) {
      if (e.destAppId !== appId) continue
      clearTimeout(e.timer)
      e.reject(nacpInbound('peer-gone', reason))
      this.msgIdPendingSheet.delete(id)
    }
  }

  /** Reject and clear everything (NACP.terminate). */
  failAll(reason: string) {
    for (const [id, e] of this.msgIdPendingSheet) {
      clearTimeout(e.timer)
      e.reject(nacpInbound('terminate', reason))
      this.msgIdPendingSheet.delete(id)
    }
  }

  has(msgId: string): boolean { return this.msgIdPendingSheet.has(msgId) }
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

/**
 * The listen-id ownership roster, read only at TEARDOWN, never for dispatch:
 *   precise unsubscribe — targetSubId → the record → off its listenId
 *   a peer vanished     — off everything it had registered (scans by appId)
 * There is deliberately no by-name / by-reqId index: matching is EventBus's bucketed wildcard lookup.
 */
export class SubscribeTable {
  /** The one sheet. Every record carries its own appId, so per-App lookups scan instead of keeping a second
   *  sheet — see the QuickSet note at the top of the file. */
  private subIdSubscribeSheet = new Map<string, SubRecord>()

  add(rec: SubRecord) { this.subIdSubscribeSheet.set(rec.subId, rec) }

  getSubRecordbySubId(subId: string): SubRecord | undefined { return this.subIdSubscribeSheet.get(subId) }

  /** Delete one subscription and return it, so the caller can `off` its listenId. */
  deleteSubRecordbySubId(subId: string): SubRecord | undefined {
    const rec = this.subIdSubscribeSheet.get(subId)
    if (rec) this.subIdSubscribeSheet.delete(subId)
    return rec
  }

  /** Delete every subscription of one appId and return them, so the caller can `off` each listenId.
   *  Scans: a peer only vanishes a handful of times per App lifetime. */
  deleteSubRecordbyAppId(appId: string): SubRecord[] {
    const out: SubRecord[] = []
    for (const rec of this.subIdSubscribeSheet.values()) if (rec.appId === appId) out.push(rec)
    for (const rec of out) this.subIdSubscribeSheet.delete(rec.subId)
    return out
  }

  /** Every record (used by NACP.terminate to off all listeners). */
  listSubRecord(): SubRecord[] { return [...this.subIdSubscribeSheet.values()] }

  clear() { this.subIdSubscribeSheet.clear() }
  size(): number { return this.subIdSubscribeSheet.size }
}

// ── ListenTable ─────────────────────────────────────────────────────────────

/** One active listen = one local handler for the notifies of a subscription THIS App requested. */
export interface ListenRecord {
  subId: string           // the subscribe message's id — the same id the subscribed side files under
  appId: string           // the peer we subscribed ON; lets a disconnect drop everything aimed at it
  targetSubName: string   // what we asked for (may contain a single-segment `*`), kept for diagnostics
  // The listener an inbound notify is delivered to. ALWAYS present: a subscription without a listener is
  // malformed, the same way a local bus.listen without a callback would be. Callers who do not care about the
  // arrivals get `() => {}` — the subscription is real either way. Named targetListener, not onNotify, so it
  // never reads as the inbound-family handler NACP.onNotify.
  targetListener: (payload: any, msg: NotifyMessage) => void
  /** Optional: called ONCE when this record leaves the table, whatever removed it — unsubscribe, the peer
   *  disconnecting, or terminate(). It exists for consumers that model a subscription as a FINITE stream and
   *  need to know it ended (NApp's `subscribe` returns an async iterable built on this). A record with no
   *  such consumer simply omits it. */
  onEnd?: () => void
}

/**
 * The local-listener roster: the SUBSCRIBING side's half of a subscription.
 *
 * Its one dispatch job is inbound notify → handler, matched by parentId. That is why, unlike the other three,
 * it is read on the hot path rather than only at teardown.
 *
 * A subscription's handler must outlive the round trip that created it. That rules out ResponsePendingTable:
 * a pending entry is SETTLED and deleted the moment its response arrives, and a subscribe is answered
 * immediately — so by the time the first notify shows up, that entry is long gone. ListenRecord outlives
 * each individual round trip and lives until unsubscribe or disconnect.
 */
export class ListenTable {
  /** The one sheet. Every record carries its own appId, so per-App lookups scan instead of keeping a second
   *  sheet — see the QuickSet note at the top of the file. */
  private subIdListenSheet = new Map<string, ListenRecord>()

  add(rec: ListenRecord) { this.subIdListenSheet.set(rec.subId, rec) }

  /** The dispatch lookup: an inbound notify's parentId → the handler that takes it. The one hot path here. */
  getListenRecordbySubId(subId: string): ListenRecord | undefined { return this.subIdListenSheet.get(subId) }

  /** Fire a removed record's `onEnd` exactly once. Every removal path funnels through here so "the record left
   *  the table" and "its stream was told" stay the same event — the same discipline NACT uses for
   *  drop-then-announce. A throwing consumer must not break teardown, hence the try/catch. */
  private end(rec: ListenRecord) {
    if (!rec.onEnd) return
    const fn = rec.onEnd
    rec.onEnd = undefined   // idempotent: a record can only end once
    try { fn() } catch { /* a consumer's cleanup must not derail ours */ }
  }

  deleteListenRecordbySubId(subId: string): ListenRecord | undefined {
    const rec = this.subIdListenSheet.get(subId)
    if (rec) { this.subIdListenSheet.delete(subId); this.end(rec) }
    return rec
  }

  /** The peer we subscribed on is gone — nothing will ever arrive for these again. Scans, same as
   *  SubscribeTable.deleteSubRecordbyAppId: a disconnect is rare. */
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
