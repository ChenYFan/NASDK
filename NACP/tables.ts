/**
 * NACP state tables — SEVEN standard tables. Fan-out on a hit is EventBus's job (its bucketed wildcard index
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
 *   OutboundBacklogTable    — messages that could not go out, held for replay when the peer returns. Stage 1
 *                             of the outbound path; a pass-through while the destination is online.
 *   AckPendingTable         — messages that reached the wire and are awaiting their ack. Stage 2.
 *   InboundReceivedTable    — message ids already handled HERE, so a replayed copy is recognised instead of
 *                             being reported as an answer nobody asked for.
 *
 * ── The outbound path is two tables, not one ──────────────────────────────────────────────────────────
 *
 *   outbound → OutboundBacklogTable → (online? straight out) → AckPendingTable → (ack) → done
 *
 * They are mutually exclusive in practice, which is why each carries its own cap rather than sharing a global
 * one: while an App is online the backlog is a pass-through and the ack table holds the in-flight window;
 * the moment the link drops, the ack table's contents move to the FRONT of the backlog and it empties. So the
 * peak is one table's worth, not two.
 *
 * The last of the three mirrors the SubscribeTable/ListenTable pattern: the sender remembers what it must
 * replay, the receiver remembers what it has already taken.
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
import type { NACPMessage, NotifyMessage, ResponseMessage } from './types.ts'
import { nacpInbound } from './errors.ts'

// ── PeerAppConnectionTable ──────────────────────────────────────────────────

/**
 * One App this NACP knows how to reach, and whether it is reachable right now.
 *
 * `offline` is not "forgotten" — it is "known, unreachable, and on the clock". That distinction is what lets
 * outbound tell two situations apart that used to look identical once the row was deleted: an appId nobody
 * ever registered (a typo, or a peer that never connected — no route, report and drop) versus one that was
 * here a moment ago and may be back (hold its traffic in the backlog). A row only leaves the sheet when the
 * App is fully gone.
 */
export type AppLinkState = 'online' | 'offline'

/**
 * What the link looked like at the instant it dropped, taken because the answer is needed LATER — at grace
 * expiry — and by then it can no longer be read: clearing a Gateway's appId also clears the Gateway slot, so
 * asking "was this the Gateway?" after the fact gets the wrong answer. Snapshot at disconnect, decide at
 * expiry.
 */
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
  /** The one sheet: appId → link record. Reverse lookups scan it — see the QuickSet note at the top. */
  private appIdPeerSheet = new Map<string, AppLinkRecord>()
  /** The peer this App treats as its outbound fallback. Written ONLY through setGateway(), which is
   *  first-come-first-served: once taken, a second declaring peer does not silently overwrite it.
   *  Whether a peer becomes the Gateway is decided purely by that peer's own declaration
   *  (the isGateway in RegisterPayload, or in the payload of the response to it), never by a local override. */
  private _gatewayPeerId?: NACTPeerId
  /** WHICH appId holds the Gateway slot. Kept beside the peerId because a Gateway is identified by its appId,
   *  never by its name matching some literal — and because several appIds can share the Gateway's peerId when
   *  they are reached THROUGH it, so peerId alone cannot say which of them is the Gateway itself. */
  private _gatewayAppId?: string

  /** Bind or re-bind an appId. A re-bind is how an offline App comes back: the state returns to `online` and
   *  the snapshot is dropped, so nothing has to remember to clear it separately. */
  bind(appId: string, peerId: NACTPeerId) { this.appIdPeerSheet.set(appId, { peerId, state: 'online' }) }

  /** Claim the Gateway slot. Succeeds when the slot is free or already held by this same peer
   *  (idempotent re-register). Returns false when another peer holds it — the caller then decides
   *  between downgrading this connection or rejecting it, rather than clobbering the slot. */
  setGateway(peerId: NACTPeerId, appId: string): boolean {
    if (this._gatewayPeerId !== undefined && this._gatewayPeerId !== peerId) return false
    this._gatewayPeerId = peerId
    this._gatewayAppId = appId
    return true
  }

  hasGateway(): boolean { return this._gatewayPeerId !== undefined }

  /** Mark one App unreachable, snapshotting what the decision at grace expiry will need. Returns the
   *  snapshot, or undefined when there was no such App or it was already offline (so a second disconnect
   *  cannot overwrite the first snapshot with a view of an already-torn-down world). */
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

  /** ALL appIds on one peer, not just the first. Several appIds share a peerId whenever they are reached
   *  through a Gateway, so "the App on this peer" is not a single thing — reading it as one silently left
   *  every appId but the first bound to a dead connection. Scans: a disconnect happens a handful of times per
   *  App lifetime. */
  listAppIdbyPeerId(peerId: NACTPeerId): string[] {
    const out: string[] = []
    for (const [appId, rec] of this.appIdPeerSheet) if (rec.peerId === peerId) out.push(appId)
    return out
  }

  /** Remove every appId on one peer. Returns them all, for the same reason listAppIdbyPeerId exists. */
  deleteAppIdbyPeerId(peerId: NACTPeerId): string[] {
    const appIds = this.listAppIdbyPeerId(peerId)
    for (const appId of appIds) this.appIdPeerSheet.delete(appId)
    if (this._gatewayPeerId === peerId) { this._gatewayPeerId = undefined; this._gatewayAppId = undefined }
    return appIds
  }

  getPeerIdbyAppId(appId: string): NACTPeerId | undefined { return this.appIdPeerSheet.get(appId)?.peerId }

  has(appId: string): boolean { return this.appIdPeerSheet.has(appId) }
  listAppId(): string[] { return [...this.appIdPeerSheet.keys()] }
  /** Only the ones reachable right now — what a caller iterating live peers actually means. */
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

  /** Reject and clear everything bound for one appId. Called when that App is FULLY cleaned up — its grace
   *  window expired, or it said goodbye — never on the bare disconnect: a peer that comes back within the
   *  window replays its answers, so failing a waiter the instant the socket drops would throw away a result
   *  that is still coming. A waiter therefore has no timeout of its own; it lives until the App is gone. */
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

// ── the three ack-round-trip tables ─────────────────────────────────────────

/** Byte cost of a message, for a queue cap ONLY — an approximation, and deliberately so.
 *
 *  Buffers and TypedArrays are summed exactly; everything else is estimated from string length. That split
 *  follows what the cap is defending: NACP exists to carry large binary, so a queue's memory is overwhelmingly
 *  its byte strings. Encoding each response through CBOR to get an exact figure would mean encoding every
 *  large payload twice (once to send, once to measure) — real cost, for precision the cap does not need.
 *
 *  Recursion is depth-limited: a pathological payload must not turn measurement into a stack overflow. */
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

/**
 * One queued outbound message, in either of the two outbound tables.
 *
 * `sentOnce` is the difference between the two things the backlog holds: a message that has never left, and
 * one that left but was not acknowledged before the link dropped. Both must go out on reconnect, so they
 * share a queue — but only the second can produce a duplicate at the far end, and that is worth being able
 * to tell apart when reading a diagnostic.
 */
export interface OutboundRecord {
  msg: NACPMessage
  destAppId: string     // where it is bound; lets a per-App sweep find it without a reverse index
  bytes: number         // this record's charge against the byte cap — see measureBytes
  sentOnce: boolean     // true = already reached the wire once, now awaiting a second attempt
}

/**
 * Shared cap bookkeeping for the two outbound queues.
 *
 * Both caps are ceilings with ONE deliberate exception: a record is admitted BEFORE the caps are re-checked,
 * so a single message larger than maxBytes still gets in — everything older is evicted first and it stays as
 * the sole occupant. The queue must be able to hold one message of the largest size the transport permits
 * (NACT caps a frame at 2GiB), and refusing it would disable delivery for exactly the messages that can least
 * afford to be dropped silently.
 *
 * Insertion order IS eviction order: a Map iterates in insertion order, so the oldest entry is simply the
 * first the iterator yields. No timestamp sort, no heap.
 */
abstract class CappedOutboundQueue {
  protected sheet = new Map<string, OutboundRecord>()
  protected _bytes = 0
  protected maxBytes: number
  protected maxCount: number

  // Fields assigned in the body rather than declared as constructor parameter properties: that TS-only
  // shorthand is not supported by Node's --experimental-strip-types, which is how this package is tested.
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

  /** Every record bound for one appId, in insertion order. */
  listByAppId(appId: string): OutboundRecord[] {
    const out: OutboundRecord[] = []
    for (const rec of this.sheet.values()) if (rec.destAppId === appId) out.push(rec)
    return out
  }

  /** Remove and return everything bound for one appId — the grace window expired, or it said goodbye. */
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

/** What a cap forced this queue to give up, and which rule did it. Mirrors the reason set on
 *  `nacp:internal:backlog:warning`, so the caller reports without re-deciding anything. */
export interface BacklogEviction {
  rec: OutboundRecord
  reason: 'notify-dropped' | 'notify-evicted' | 'fifo-evicted'
}

/**
 * Messages that could not go out, held for replay when the peer returns. THE first stage of the outbound
 * path: everything passes through here, and while the destination is online that pass-through is immediate
 * (enqueue then straight back out), so the queue only accumulates while an appId is offline.
 *
 * Keyed by the message's own id. Grouping is by DESTINATION appId, not by peerId, because the two clearing
 * rules are per-App: a 120s grace expiry and an inbound unregister each discard exactly one App's messages —
 * and several appIds can share one peerId when they are reached through a Gateway, so a peer-keyed queue
 * could not discard just one of them.
 *
 * Overflow spends notify first, in three tiers:
 *
 *   1. the ARRIVING message is a notify   → drop the arrival, leave the queue untouched
 *   2. the arrival is anything else       → evict oldest notifies until the caps hold
 *   3. no notify left to spend            → plain FIFO on the oldest records
 *
 * Notify is the only type that expects no ack at all, which is precisely what makes it the cheapest thing to
 * lose: its content is observational, and the reliable terminal of any call is its response. Tier 1 drops the
 * newcomer rather than making room for it because a queued notify has already waited — it is closer to being
 * sent than one that just arrived.
 */
export class OutboundBacklogTable extends CappedOutboundQueue {
  /** Admit one message and settle the caps. Returns what was given up, if anything — an empty array is the
   *  normal path. When the arrival itself is dropped (tier 1) it appears here with `notify-dropped`, so a
   *  caller can tell "queued" from "refused" without a second return channel. */
  add(rec: OutboundRecord): BacklogEviction[] {
    const arrivalIsNotify = rec.msg.type === 'notify'
    this.sheet.set(rec.msg.id, rec)
    this._bytes += rec.bytes
    if (!this.overCap) return []

    // Tier 1: a notify that does not fit is simply not worth making room for.
    if (arrivalIsNotify) {
      this.take(rec.msg.id)
      return [{ rec, reason: 'notify-dropped' }]
    }

    const out: BacklogEviction[] = []
    // Tier 2, then tier 3. Two passes over the same sheet: the first spends every notify it can, and only a
    // still-broken cap moves on to reliable traffic. One pass with a predicate could not express the
    // priority, since insertion order alone would reach a reliable record before a younger notify.
    for (const reason of ['notify-evicted', 'fifo-evicted'] as const) {
      for (const [id, r] of this.sheet) {
        if (!this.overCap) return out
        if (id === rec.msg.id) continue                                  // the arrival survives its own admission
        if (reason === 'notify-evicted' && r.msg.type !== 'notify') continue
        this.take(id)
        out.push({ rec: r, reason })
      }
    }
    return out
  }

  /** Put records back at the FRONT, ahead of everything already queued. Used when a link drops and the
   *  awaiting-ack records return to the backlog: they left the wire before anything still queued behind them,
   *  so replaying them first is what keeps the wire order they originally had.
   *
   *  A Map cannot prepend, so the sheet is rebuilt. That is O(n) on a table capped at 1024, and it happens
   *  once per disconnect — cheaper than carrying a linked list to make an operation this rare O(1). */
  unshiftAll(recs: OutboundRecord[]) {
    if (recs.length === 0) return
    const existing = [...this.sheet]
    this.sheet.clear()
    for (const rec of recs) { this.sheet.set(rec.msg.id, rec); this._bytes += rec.bytes }
    for (const [id, rec] of existing) if (!this.sheet.has(id)) this.sheet.set(id, rec)
  }

  /** Remove and return everything bound for one appId, ready to go out now that it is reachable again.
   *  Draining is the same operation as discarding — the difference is only what the caller does next — so
   *  both ride `deleteByAppId` rather than growing a second method that would have to stay in sync. */
  drainByAppId(appId: string): OutboundRecord[] { return this.deleteByAppId(appId) }
}

// ── AckPendingTable ─────────────────────────────────────────────────────────

/**
 * Messages that reached the wire and are waiting to be acknowledged. THE second stage: only what actually
 * left is here, so nothing in this table is "yet to be sent for the first time" — that is the backlog's job.
 *
 * Keyed by the message's own id, which is exactly what an inbound ack names in `meta.parentId`.
 *
 * Notify and ack never enter: neither expects an ack, so for them reaching the wire IS the terminal. The
 * types that do wait are request / response / register / unregister / subscribe / unsubscribe.
 *
 * There is no retry counter and no per-record timer. An ack that has not arrived within the ack timeout does
 * not mean "try again" — on a transport that guarantees ordered, lossless delivery it means the peer is
 * unreachable, so the record goes back to the backlog and the appId goes offline. Retransmission therefore
 * only ever happens on reconnect, which is also why the timeout is one clock per App rather than one per
 * message: the first record to time out condemns the whole App, and the rest follow it into the backlog.
 */
export class AckPendingTable extends CappedOutboundQueue {
  /** Admit a record and settle the caps. Overflow here is plain FIFO — the notify-first tiers do not apply,
   *  since notify never enters this table in the first place. */
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

  /** The ack arrived: this message is done. */
  settle(msgId: string): OutboundRecord | undefined { return this.take(msgId) }

  /** Hand every record for one appId back, marked as having been sent once. The link dropped, so they return
   *  to the backlog to be replayed on reconnect; whether the far end already has them is unknowable from
   *  here, and its dedup table is what makes a second copy harmless. */
  drainByAppId(appId: string): OutboundRecord[] {
    const out = this.deleteByAppId(appId)
    for (const rec of out) rec.sentOnce = true
    return out
  }
}

// ── InboundReceivedTable ────────────────────────────────────────────────────

/**
 * Message ids this App has already handled, so a replayed copy is recognised instead of processed twice.
 *
 * It holds ids and nothing else — never a payload. Its whole job is to answer "have I handled this before",
 * which is what makes a duplicate arrival idempotent: handle once, ack every time.
 *
 * Why suppression needs a table rather than just tolerating the duplicate: `ResponsePendingTable.settle`
 * deletes the waiter, so a second copy of a response finds nothing and would be reported as
 * `has-no-consumer` — turning a healthy replay into a false error. With this table `has-no-consumer` keeps
 * its original meaning: a response nobody ever asked for.
 *
 * Notify and ack get no record. Neither is ever replayed (they leave the backlog and are done), so an entry
 * for them could only ever be dead weight — and notify is the highest-volume type there is, which would make
 * it dead weight at exactly the worst scale.
 *
 * Lifetime is the peer's online span plus its grace window, not a TTL of its own: an id matters only while
 * its sender might still replay it, and a sender that is gone for good takes that possibility with it. The
 * count cap is what bounds it in the meantime; the byte cap is nominal, since ids are all it stores.
 */
export class InboundReceivedTable {
  /** The one sheet: message id → the appId it came from. */
  private msgIdSeenSheet = new Map<string, string>()
  private maxCount: number

  constructor(maxCount: number) { this.maxCount = maxCount }

  /** Record an id as handled, evicting oldest-first once the count cap is passed. An eviction only costs the
   *  ability to recognise a replay of something ancient, which is why this one needs no reporting channel. */
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
