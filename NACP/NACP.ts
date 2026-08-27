/**
 * NACP — the protocol face, one of NASDK's three parallel stack members (NApp / NACP / NACT). It regulates
 * what a message looks like, how a request pairs
 * with its response, and how addressing fields are stamped. It is an envelope-format spec plus pairing
 * semantics — NOT a post office: it does not forward (that is the App's inbound behaviour), does not know
 * about connections (that is NACT), and never interprets payload.
 *
 * Owns three connection-level tables (see tables.ts), all forward-lookup only. Reaches everything else
 * through `this.napp` — the shared bus, the App's identity and declaration, the bound Processors
 * (`getProcessor`), and its sibling NACT's single outbound face (`nact.sendToPeer`). One reference, no
 * capability box; the layer being crossed is legible at every call site.
 *
 * ── subscribe/notify: a REMOTE EventBus subscription machine ─────────────────────────────────────────
 * subscribe is not a mechanism of its own. It means "register a listener on YOUR NApp EventBus for me, and
 * forward whatever it catches to me as a notify". Apart from crossing a process boundary it is exactly a
 * local `bus.listen`:
 *
 *     bus.listen(name, cb) → listenId   ⇔   subscribe(to, targetSubName, targetListener) → subId
 *     bus.off(listenId)                 ⇔   unsubscribe(targetSubId)
 *     cb fires                          ⇔   notify{parentId=subId, hitSubName} arrives → targetListener
 *     emit(name, payload)               ⇔   the subscribed side packs a notify and sends it out
 *
 * The analogy is exact down to the callback: a `bus.listen` without a cb is meaningless, and so is a subscribe
 * without a targetListener — it would make the peer attach a real listener and pay a real notify per hit for an
 * arrival nobody takes. The argument may be omitted; the FIELD is always there, `() => {}` if nothing was given.
 *
 * This is why the bound Processor's callbacks emit onto the bus instead of notifying point-to-point: once a
 * call's process/terminal ARE bus events, subscribing to them needs no special case, and the initiator's own
 * "implicit subscription" stops being implicit — see the AUTO-SUBSCRIPTION note on request() below.
 *
 * inbound()/outbound() are deliberately public. Each emits its nacp:{inbound|outbound}:* event FIRST, then
 * performs side effects. WARNING: calling them directly bypasses the facade and the outbound side effects
 * (auto-subscription, pending registration).
 */

import type { Processor } from '../types.ts'
import type { NACTPeerId, Peer } from '../NACT/types.ts'
import type { NApp } from '../NApp/NApp.ts'
import type {
  AckMessage, BuildOpt, NACPMessage, NACPType, NotifyMessage, RegisterMessage, RegisterPayload, RegisterResponsePayload,
  SubscribePayload, SubscribeResponsePayload, UnsubscribePayload,
  RequestKind, RequestMessage, ResponseMessage, SignalMessage, SignalOpt, SubscribeMessage, UnregisterMessage, UnsubscribeMessage,
} from './types.ts'
import { PROTOCOL_V, buildMessage } from './types.ts'
import {
  AckPendingTable, InboundReceivedTable, ListenTable, OutboundBacklogTable,
  PeerAppConnectionTable, ResponsePendingTable, SubscribeTable, measureBytes,
} from './tables.ts'
import type { OutboundRecord } from './tables.ts'
import {
  NACPInternal, callProcessName, callResponseName, eventSignalName,
  inboundEvent, outboundEvent,
} from './events.ts'
import { NACPError, nacpInbound, nacpOutbound } from './errors.ts'
import { NACTEvent } from '../NACT/events.ts'

const RESPONSE_TIMEOUT_MS = 10000          // register / subscribe / unsubscribe: protocol handshakes, must be fast
const REQUEST_TIMEOUT_MS  = -1             // request: business call — framework has no idea how long it takes; -1 = no timeout

/** The two types that expect no ack: for them, reaching the wire IS the terminal. Everything else waits to be
 *  acknowledged before it is considered delivered. Kept as one predicate so the rule lives in a single place —
 *  it is read by the outbound path (does this enter the ack-pending table?), by the inbound path (does this
 *  earn a dedup record?) and by the backlog's eviction tiers. */
function expectsAck(type: NACPType): boolean { return type !== 'notify' && type !== 'ack' }

export class NACP {
  private peerAppTable = new PeerAppConnectionTable()
  private pendingTable = new ResponsePendingTable()
  private subscribeTable = new SubscribeTable()   // subscribed side: who subscribed to my bus → notify OUTBOUND
  private listenTable = new ListenTable()         // subscribing side: my own listeners → notify INBOUND
  /** Outbound stage 1: what could not go out yet. A pass-through while the destination is online. */
  private backlogTable: OutboundBacklogTable
  /** Outbound stage 2: what left the wire and is waiting to be acknowledged. */
  private ackPendingTable: AckPendingTable
  /** Inbound: ids already handled, so a replayed copy is recognised rather than processed twice. */
  private inboundReceivedTable: InboundReceivedTable
  /** One ack clock per App, not per message. The first message to time out condemns the whole App — the rest
   *  follow it into the backlog — so a per-record timer would be N timers racing to the same conclusion. */
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** One grace clock per offline App. Fires once, at which point that App is forgotten entirely. */
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Resolvers waiting for a specific message to reach the wire. This is what makes `notify` / `ack` awaitable
   *  in the offline case: they cannot wait for an ack (they get none), so their terminal is departure, which
   *  may be minutes away while a backlog holds them. */
  private departureWaiters = new Map<string, (sent: boolean) => void>()
  /** Resolvers waiting for a specific outbound message to be acknowledged. */
  private ackWaiters = new Map<string, { resolve: (ok: boolean) => void }>()
  /** Reverse reference — NApp's PUBLIC face: id / isGateway / autoMultiGatewayDowngrade / bus / nact /
   *  buildDecl() / getProcessor(). The ONLY thing NACP holds from above. Reading `this.napp.nact` here is
   *  deliberate: the layer being crossed is visible at the call site, and it resolves at call time, so the
   *  construction cycle never forms.
   *
   *  There is no private-capability box any more. It used to carry one entry, `dispatch(kind)`, because NApp's
   *  `processors` map is private; that became the public `napp.getProcessor(kind)` — the LOOKUP is public, the
   *  table still is not. So NACP and NACT are now symmetric: both hold exactly `this.napp`. */
  napp: NApp

  /** NACP subscribes to its sibling's physical-disconnect event ITSELF. NACP and NACT are peers that talk
   *  through `this.napp.nact` / `this.napp.nacp` and share the one EventBus, so listening directly is the
   *  normal shape here — routing it through NApp would make the parent relay a message between two children
   *  that already reach each other. `this.napp.bus` is safe at this point: NApp's `bus` is a field
   *  initialiser, so it exists before the constructor body that news us. */
  constructor(napp: NApp) {
    this.napp = napp
    this.backlogTable = new OutboundBacklogTable(napp.queueMaxBytes, napp.queueMaxCount)
    this.ackPendingTable = new AckPendingTable(napp.queueMaxBytes, napp.queueMaxCount)
    this.inboundReceivedTable = new InboundReceivedTable(napp.queueMaxCount)
    this.napp.bus.listen(NACTEvent.peerDisconnect, ({ peerId }: { peerId: NACTPeerId }) => {
      this.onPeerDisconnect(peerId)
    })
  }

  // ── appId↔peerId table (the one irreducible mapping: logical name → physical connection) ──
  bindAppId(appId: string, peerId: NACTPeerId) { this.peerAppTable.bind(appId, peerId) }
  checkAppId(appId: string): boolean { return this.peerAppTable.has(appId) }
  dropAppId(appId: string) { this.peerAppTable.deleteAppIdbyAppId(appId) }
  /** Every appId this NACP still knows, reachable or not. */
  listAppId(): string[] { return this.peerAppTable.listAppId() }
  /** Only the ones reachable right now. What "connected" means to a caller, and what a goodbye can reach:
   *  sending an unregister to an offline App would queue a message nobody can answer and then wait out its
   *  handshake timeout. */
  listOnlineAppId(): string[] { return this.peerAppTable.listOnlineAppId() }
  getAppPeerId(appId: string): NACTPeerId | undefined { return this.peerAppTable.getPeerIdbyAppId(appId) }
  /** Which peer currently serves as this App's outbound fallback (undefined = none). */
  getGatewayPeerId(): NACTPeerId | undefined { return this.peerAppTable.getGatewayPeerId() }

  /**
   * Decide whether a freshly registered peer becomes this App's outbound fallback. Both sides call this —
   * the answering side with the peer's RegisterPayload.isGateway, the dialling side with the isGateway in the
   * response payload — so ONE rule governs the slot instead of the old asymmetry (peer's declaration on one side,
   * a local `asGateway` override on the other).
   *
   * The slot is first-come-first-served. A second declaring peer never clobbers it; the caller picks its
   * fate from the return value:
   *   'not-declared' — the peer is a plain App, nothing to do
   *   'adopted'      — it is now the fallback
   *   'downgraded'   — it declared Gateway but lost the race; autoMultiGatewayDowngrade is ON so the link
   *                    stays usable as a plain App link (this is how a relay node holds two Gateways)
   *   'conflict'     — same, but the switch is OFF: the caller must unregister and drop the link
   */
  settleGatewayByDeclared(appId: string, peerId: NACTPeerId, peerDeclaredGateway: boolean):
    'not-declared' | 'adopted' | 'downgraded' | 'conflict' {
    if (!peerDeclaredGateway) return 'not-declared'
    if (this.peerAppTable.setGateway(peerId, appId)) return 'adopted'
    if (!this.napp.autoMultiGatewayDowngrade) return 'conflict'
    this.napp.bus.emit(NACPInternal.gatewayWarning, {
      appId, peerId, keptGatewayPeerId: this.peerAppTable.getGatewayPeerId(), reason: 'multi-gateway-downgraded',
    })
    return 'downgraded'
  }

  /** Observation: how many subscriptions this NACP currently serves (used by tests / diagnostics). */
  /** Subscriptions this NACP SERVES — listeners on our bus, registered for peers. */
  getSubCount(): number { return this.subscribeTable.size() }
  /** Subscriptions this NACP HOLDS — our own handlers, waiting on notifies from peers. */
  getListenCount(): number { return this.listenTable.size() }
  getPendingCount(): number { return this.pendingTable.size() }

  // ── build ──

  private build(type: NACPType, to: string, opt: BuildOpt = {}): NACPMessage {
    // register always carries this App's own identity fields; callers never supply them.
    if (type === 'register') opt = { ...opt, isGateway: this.napp.isGateway, decl: this.napp.buildDecl() }
    return buildMessage(this.napp.id, type, to, opt)
  }

  /**
   * The public outbound face. Two stages sit behind it now, and which one a message stops at is decided by
   * one question: is the destination reachable right now?
   *
   *   outbound → backlog → [online? straight out] → ack-pending → [ack] → done
   *                        [offline? stays put until the peer returns]
   *
   * Returns whether the message was ACCEPTED, which is not the same as "left the wire". A message held for an
   * offline peer returns true — it will go out when that peer comes back, and reporting false would say it was
   * lost. The three genuine failures still return false: self-addressed, no-route (an appId nobody registered),
   * send-failed. Callers that need to know about DEPARTURE rather than acceptance await it — see `send`.
   *
   * `no-route` deliberately does NOT queue. An appId that was never registered, or one already forgotten, is a
   * fact the caller should hear about now: there is no peer coming back for it, so holding its traffic would
   * only delay the error and grow a queue nobody will ever drain. Queueing is for appIds we KNOW, that are
   * merely offline — the distinction the link table's offline state exists to make.
   */
  outbound(msg: NACPMessage, opt?: { peerId?: NACTPeerId; forwarded?: boolean; retransmit?: boolean }): boolean {
    // An explicit peerId bypasses both stages: it is used when the appId table cannot help yet (a register
    // rejection, answered straight down the inbound peer before any binding exists). There is no App to be
    // offline, so there is nothing to queue against.
    if (opt?.peerId !== undefined) return this.wireOut(msg, opt.peerId, opt)

    // Addressed to ourselves: there is no wire to put it on. Checked first, and before any queueing, because
    // it can never become deliverable — waiting would not help. Without it the packet would miss the appId
    // sheet (an App is never a key in its own) and fall through to the Gateway, which knows us and would
    // forward it straight back: a round trip ending in local delivery, not the no-op asked for.
    if (msg.to === this.napp.id) {
      this.napp.bus.emit(outboundEvent(msg), { toPeerId: undefined, msg })
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'self-addressed' })
      return false
    }

    // A forwarded packet is not ours: we are a Gateway relaying someone else's traffic, so it earns no
    // backlog entry and no ack tracking. Its sender is the one holding it for replay.
    if (opt?.forwarded) {
      const toPeerId = this.peerAppTable.getPeerIdbyAppId(msg.to) ?? this.peerAppTable.getGatewayPeerId()
      return this.wireOut(msg, toPeerId, opt)
    }

    const reachable = this.resolveRoute(msg.to)
    // Neither known-and-online nor known-and-offline: nothing to wait for.
    if (reachable === 'unknown') {
      this.napp.bus.emit(outboundEvent(msg), { toPeerId: undefined, msg })
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'no-route' })
      return false
    }

    // Stage 1. A retransmit is already in the backlog (it was put back there when the link dropped), so it
    // must not be re-admitted — that would both double-count its bytes and reset its position in the queue.
    if (!opt?.retransmit) {
      const rec: OutboundRecord = { msg, destAppId: msg.to, bytes: measureBytes(msg), sentOnce: false }
      for (const ev of this.backlogTable.add(rec)) {
        this.napp.bus.emit(NACPInternal.backlogWarning, { msg: ev.rec.msg, reason: ev.reason })
        this.settleDeparture(ev.rec.msg.id, false)
      }
      // The arrival itself was refused by a cap (only ever a notify). It is gone; say so.
      if (!this.backlogTable.has(msg.id)) return false
    }

    if (reachable === 'offline') return true    // accepted, held; departure comes with the reconnect
    return this.popOne(msg.id)
  }

  /** Is this appId somewhere we can send to, somewhere that will come back, or nowhere at all?
   *
   *  A Gateway makes the third case rarer than it looks: with a fallback peer available, an appId we have
   *  never heard of is still routable, because the star centre is one hop from everyone and knows destinations
   *  we do not. So `unknown` means "not known to us AND no fallback to ask". */
  private resolveRoute(appId: string): 'online' | 'offline' | 'unknown' {
    const state = this.peerAppTable.getState(appId)
    if (state === 'online') return 'online'
    if (state === 'offline') return 'offline'
    return this.peerAppTable.getGatewayPeerId() ? 'online' : 'unknown'
  }

  /** Take one message out of the backlog and put it on the wire, moving it to stage 2 if it expects an ack.
   *  Returns whether it reached NACT. */
  private popOne(msgId: string): boolean {
    const rec = this.backlogTable.get(msgId)
    if (!rec) return false
    const toPeerId = this.peerAppTable.getPeerIdbyAppId(rec.msg.to) ?? this.peerAppTable.getGatewayPeerId()
    const sent = this.wireOut(rec.msg, toPeerId, {})
    if (!sent) return false

    this.backlogTable.deleteByAppId(rec.destAppId).forEach((r) => {
      // Only this one message was meant to leave; put the rest back exactly where they were.
      if (r.msg.id !== msgId) this.backlogTable.add(r)
    })

    if (!expectsAck(rec.msg.type)) {
      // notify / ack are done the moment they depart — there is no acknowledgement coming.
      this.settleDeparture(rec.msg.id, true)
      return true
    }
    for (const ev of this.ackPendingTable.add(rec)) {
      this.napp.bus.emit(NACPInternal.ackWarning, { msg: ev.msg, reason: 'pending-overflow' })
      this.settleAck(ev.msg.id, false)
    }
    this.armAckTimer(rec.destAppId)
    this.settleDeparture(rec.msg.id, true)
    return true
  }

  /** The last step before NACT: announce, then hand over. Every attempt to leave is announced, delivered or
   *  not, so `nacp:outbound:{type}` stays a complete record of what this App tried to send. */
  private wireOut(msg: NACPMessage, toPeerId: NACTPeerId | undefined, opt: { forwarded?: boolean }): boolean {
    this.napp.bus.emit(outboundEvent(msg), { toPeerId, msg })
    if (opt.forwarded) this.napp.bus.emit(NACPInternal.gatewaySuccess, { toPeerId, msg, reason: 'forwarded' })
    if (!toPeerId) {
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'no-route' })
      return false
    }
    if (!this.napp.nact.sendToPeer(toPeerId, msg)) {
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'send-failed' })
      return false
    }
    return true
  }

  /** Send and await DEPARTURE. The awaitable form of `outbound` for the two types that get no ack: their
   *  terminal is reaching the wire, which for an offline destination is however long the peer takes to return.
   *  Resolves false only when the message can never leave (self-addressed, no-route, or dropped by a cap). */
  private send(msg: NACPMessage): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.departureWaiters.set(msg.id, resolve)
      if (!this.outbound(msg)) this.settleDeparture(msg.id, false)
    })
  }

  /** Send and await the ACK. The awaitable form for types whose terminal is being acknowledged. Resolves
   *  false when the message can never leave, or when it was given up on (cap eviction, or the App being
   *  forgotten). */
  private send4Ack(msg: NACPMessage): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.ackWaiters.set(msg.id, { resolve })
      if (!this.outbound(msg)) this.settleAck(msg.id, false)
    })
  }

  private settleDeparture(msgId: string, sent: boolean) {
    const resolve = this.departureWaiters.get(msgId)
    if (!resolve) return
    this.departureWaiters.delete(msgId)
    resolve(sent)
  }

  private settleAck(msgId: string, ok: boolean) {
    const w = this.ackWaiters.get(msgId)
    if (!w) return
    this.ackWaiters.delete(msgId)
    w.resolve(ok)
  }

  /** Start the ack clock for one App, if it is not already running. One clock per App: the first unacked
   *  message to expire condemns the App as a whole, so a second clock could only ever reach the same verdict
   *  later. Rearmed after each ack while anything is still outstanding. */
  private armAckTimer(appId: string) {
    if (this.ackTimers.has(appId)) return
    const t = setTimeout(() => {
      this.ackTimers.delete(appId)
      const oldest = this.ackPendingTable.listByAppId(appId)[0]
      if (!oldest) return
      this.napp.bus.emit(NACPInternal.ackWarning, { msg: oldest.msg, reason: 'timeout' })
      // Same verdict as a physical disconnect, reached sooner: on an ordered, lossless transport an ack that
      // never came means the peer is not processing, so there is nothing to retry against a live link.
      this.markOffline(appId)
    }, this.napp.ackTimeoutMs)
    t.unref?.()
    this.ackTimers.set(appId, t)
  }

  /** Stop this App's ack clock, restarting it only if something is still waiting. */
  private rearmAckTimer(appId: string) {
    const t = this.ackTimers.get(appId)
    if (t) { clearTimeout(t); this.ackTimers.delete(appId) }
    if (this.ackPendingTable.listByAppId(appId).length > 0) this.armAckTimer(appId)
  }

  // ── outbound helpers ──

  /**
   * Send a request and await its ONE terminal response.
   *
   * AUTO-SUBSCRIPTION for event kinds: `subscribe(autoSub:true)` builds the LOCAL half of a subscribe before
   * the request goes out, so a process notify arriving immediately already has a listener waiting. It is the
   * same `subscribe()` an explicit caller uses — only two things differ, and both are passed as opts:
   *
   *   subId = reqId — the responding side stamps the reqId into every notify's `parentId` (its own half files
   *                   the SubscribeTable record under the reqId too), so the ListenTable key must match it.
   *                   Without this the key would be the subscribe message's own UUID and no notify would ever
   *                   find its handler.
   *   autoSub       — no subscribe message crosses the wire. The remote half is registered by `onRequest`
   *                   calling `onSubscribe(autoSub:true)` when the request lands, not by a subscribe packet.
   *
   * A virtual message is a REAL message whose physical transmission both sides agreed to skip — so each of the
   * four halves fires at exactly the position the real packet would have reached, never at some convenient
   * hook. subscribe is born on the way out and lands in onSubscribe; unsubscribe is born when the response
   * goes out and lands when the response comes in. That gives one symmetric table:
   *
   *              │ open                              │ close
   *   requesting │ request()  → subscribe(autoSub)   │ onResponse()  → unsubscribe(autoSub)
   *   responding │ onRequest() → onSubscribe(autoSub)│ response out  → onUnsubscribe(autoSub)
   *
   * Nothing crosses the wire and nothing is answered, exactly as nothing was sent to open it.
   */
  request(
    to: string,
    opt: {
      kind: RequestKind; target?: string; payload?: any
      onProcess?: (chunk: any) => void; onProcessEnd?: () => void
    },
  ): { reqId: string; response: Promise<ResponseMessage> } {
    const msg = this.build('request', to, { kind: opt.kind, target: opt.target, payload: opt.payload }) as RequestMessage
    // event ONLY: ability produces no process stream by definition, so there is nothing to subscribe.
    // Gated on kind ALONE — the same condition the responding side uses, because that is all it can see in the
    // request. An absent onProcess is a listener of `() => {}`, never a missing subscription: were this gated
    // on onProcess too, the peer would still attach its half and notify into a subscription we never filed.
    if (opt.kind === 'event') {
      this.subscribe(to, callProcessName(opt.kind, msg.id), opt.onProcess, {
        subId: msg.id, autoSub: true, onEnd: opt.onProcessEnd,
      })
    }
    return { reqId: msg.id, response: this.Send4Response(msg, to) }
  }

  /**
   * A process chunk, one-way. The one type that expects no ack at all, which is what makes it the cheapest
   * thing to lose when a queue overflows: its content is observational, and the reliable terminal of any call
   * is that call's response.
   *
   * Resolves when the notify DEPARTS — for an online peer that is immediate, for an offline one it is however
   * long the peer takes to come back, because the notify waits in the backlog until then. Resolves false only
   * when it can never leave: no route, addressed to self, or dropped by a cap.
   */
  notify(to: string, opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any }): Promise<boolean> {
    return this.send(this.build('notify', to, opt))
  }

  /** Send one reliable input/control message to an active Event request. The Signal has its own message id;
   *  parentId names the original request, while the ACK names this Signal's id. */
  signal(to: string, opt: SignalOpt): Promise<boolean> {
    return this.send4Ack(this.build('signal', to, {
      parentId: opt.parentId,
      signalKind: opt.kind,
      ...(opt.kind === 'normal' && { payload: opt.payload }),
    }))
  }

  /**
   * AutoSub closing half: sending an event request's response IS sending the virtual unsubscribe (both sides
   * agreed to skip it), so it is born here, at the response's own outbound. `opt.kind === 'event'` says "this
   * answers an event request" and `opt.parentId` is that request's id — the AutoSub's subId. It lands straight
   * in our own `onUnsubscribe`, because the SubscribeTable half being closed is ours.
   *
   * Answering a kind we never opened a subscription for (the no-processor reject) is harmless: onUnsubscribe
   * with autoSub is silent on a missing record.
   *
   * Resolves once the response has been ACKNOWLEDGED — a response is the terminal of somebody's call, so
   * "delivered" is the only useful meaning of done for it, and departure alone does not establish that.
   * Resolves false when it can never be delivered.
   *
   * The AutoSub teardown runs EITHER WAY, and synchronously: the SubscribeTable half being closed is ours, so
   * it must go even when the packet cannot leave, or a dead peer would leak a listener on our own bus. It is
   * also strictly a first-send action — a replay of this response must not close a subscription twice, which is
   * why the retransmit path goes through `outbound` and never back through here.
   */
  response(
    to: string,
    opt: { parentId: string; isOk: boolean; whyNotOk?: string; kind?: RequestKind; payload?: any },
  ): Promise<boolean> {
    const acked = this.send4Ack(this.build('response', to, opt))
    if (opt.kind === 'event') {
      this.onUnsubscribe({ id: opt.parentId, from: to, payload: { targetSubId: opt.parentId } } as UnsubscribeMessage, { autoSub: true })
    }
    return acked
  }

  /**
   * The DIALLING side of the register handshake — the mirror of `onRegister`, and it does the whole thing,
   * not just "send and await". Everything past the physical dial is protocol: bind, await, verify identity,
   * read the peer's declaration, settle the Gateway slot, announce online. `onRegister` has `reject()`,
   * this has `fail()`; both mean emit errorRegister, undo the bind, close the link.
   *
   * `peer` is taken because the two ends of that work need it: `peer.id` to bind, `peer.close()` to tear down.
   * Returns whether the App is now registered. The reason lives on `nacp:internal:register:error`, so a
   * caller that only needs to branch reads the boolean and an observer that needs the cause reads the bus.
   */
  async register(to: string, peer: Peer): Promise<boolean> {
    // Bind eagerly: the handshake response routes by appId, so without this it could not find its way back.
    this.bindAppId(to, peer.id)
    const fail = (reason: string): false => {
      this.napp.bus.emit(NACPInternal.registerError, { fromPeerId: peer.id, from: to, reason })
      this.dropAppId(to)
      try { peer.close() } catch { /* already gone */ }
      return false
    }

    let res: ResponseMessage
    try {
      res = await this.Send4Response(this.build('register', to) as RegisterMessage, to)
    } catch (e) {
      // Two ways this rejects, and they are different facts. `timeout` means nothing came back — the peer is
      // gone, or `to` was not its name so it dropped the packet. `response-not-ok` means it answered and
      // refused; onResponse put its `whyNotOk` in the message, so passing that through makes both ends report
      // the identical cause — the same string, called whyNotOk on the wire and reason on the bus.
      // Every branch yields a kebab-case identifier, so reason stays comparable on all paths.
      if (!(e instanceof NACPError)) return fail('register-failed')
      if (e.code === 'response-not-ok') return fail(e.message)
      return fail(e.code === 'timeout' ? 'response-timeout' : e.code)
    }
    // The peer answers only if `to` is its own name, so a mismatch means we reached the wrong App.
    if (res.from !== to) return fail('expect-mismatch')

    // Same rule as the answering side: adopt as fallback iff the PEER declared itself a Gateway. isGateway
    // rides this response's typed payload, not meta — it belongs to this one response only.
    const reg = res.payload as RegisterResponsePayload | undefined
    const gatewayVerdict = this.settleGatewayByDeclared(to, peer.id, reg?.isGateway === true)
    if (gatewayVerdict === 'conflict') {
      // Say goodbye before tearing down so the peer drops our appId instead of waiting for a heartbeat.
      // Fire-and-forget with the rejection swallowed: fail() closes the socket right after, which would
      // otherwise surface as an unhandled rejection on the pending unregister waiter.
      void this.unregister(to)?.catch(() => { /* peer is going away anyway */ })
      return fail('multi-gateway')
    }
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId: to, reason: 'bound', isGateway: gatewayVerdict === 'adopted' })
    return true
  }

  unregister(to: string): Promise<ResponseMessage> {
    return this.Send4Response(this.build('unregister', to), to)
  }

  /**
   * Subscribe on a peer's bus. Resolves with the confirming response; the caller keeps `subId` (= the
   * subscribe message id) to unsubscribe later, and registers a local listener for the arriving notifies.
   *
   * The ListenTable record is built UNCONDITIONALLY. A subscription without a listener is malformed — it would
   * make the peer register a real listener and pay a real notify per hit for an arrival nobody takes — so
   * `targetListener` always exists; omitting the argument means `() => {}`, not "no subscription".
   *
   * The two opt fields each do exactly one thing, and are deliberately NOT merged:
   *   subId   — override the ListenTable key. A notify is matched by its `parentId`, so the key must equal
   *             whatever the SUBSCRIBED side will stamp there. Explicit subscribe: that is this message's own
   *             id (the default). AutoSub: the responder stamps the reqId, so `request()` passes the reqId.
   *   autoSub — build the local half only and return without going out. AutoSub sends no subscribe message;
   *             its remote half is `onSubscribe(autoSub:true)`, driven by the request's own arrival.
   */
  subscribe(
    to: string,
    targetSubName: string,
    targetListener: (payload: any, msg: NotifyMessage) => void = () => {},
    opt: { subId?: string; autoSub?: boolean; onEnd?: () => void; onSubId?: (subId: string) => void } = {},
  ): Promise<ResponseMessage> | void {
    const msg = this.build('subscribe', to, { targetSubName }) as SubscribeMessage
    // ── subId is never CHOSEN, it is READ off a message that already crossed the wire ──
    // Both halves of a subscription must key on the same id, and neither side can invent one the other would
    // know. So the id always comes from the message that put the two sides in contact:
    //   real subscribe — this subscribe message's own `msg.id`. The peer's `onSubscribe` does `subId = msg.id`
    //                    and stamps it into every notify's parentId, so a locally-minted key would miss.
    //   AutoSub        — `opt.subId`, which is the REQUEST's id. Not a made-up value either: the requester
    //                    minted it, the responder read it off the request, so both already share it. That is
    //                    the ONLY legitimate use of this option.
    // A caller who supplies anything else breaks the pairing and every notify lands as has-no-consumer.
    const subId = opt.subId ?? msg.id
    this.listenTable.add({ subId, appId: to, targetSubName, targetListener, onEnd: opt.onEnd })
    // Hand the id back SYNCHRONOUSLY, before the round trip: a caller that wraps this in a stream needs it to
    // build the cancel path, and `break` can happen long before the response lands.
    opt.onSubId?.(subId)
    if (opt.autoSub) return
    return this.Send4Response(msg, to).catch((e) => { this.listenTable.deleteListenRecordbySubId(subId); throw e })
  }

  /**
   * Cancel a subscription on a peer (a remote `off`). Also drops the local ListenTable record.
   *
   * `autoSub` mirrors the one on `subscribe()`: drop the local half only and return without going out. An
   * AutoSub was never announced to the peer, so there is nothing to cancel there — the peer closes its own
   * half from its Processor's terminal, via `onUnsubscribe(autoSub:true)`.
   */
  unsubscribe(to: string, targetSubId: string, opt: { autoSub?: boolean } = {}): Promise<ResponseMessage> | void {
    const msg = this.build('unsubscribe', to, { targetSubId }) as UnsubscribeMessage
    this.listenTable.deleteListenRecordbySubId(targetSubId)
    if (opt.autoSub) return
    return this.Send4Response(msg, to)
  }

  /** Build a pending entry, outbound, and return a Promise for the ONE terminal response. This is a big
   *  function — it wraps timeout + settle into a single awaitable, which is why it gets a capital‑S name.
   *  It knows NOTHING about auto-subscription; that belongs to the caller (request / subscribe / etc.). */
  private Send4Response(
    msg: NACPMessage, destAppId: string,
  ): Promise<ResponseMessage> {
    const isRequest = msg.type === 'request'
    const timeoutMs = isRequest ? REQUEST_TIMEOUT_MS : RESPONSE_TIMEOUT_MS
    return new Promise<ResponseMessage>((resolve, reject) => {
      const timer = timeoutMs < 0 ? undefined : setTimeout(() => {
        this.pendingTable.settle(msg.id)
        reject(nacpOutbound('timeout', `no response for ${msg.type} ${msg.id} within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingTable.add(msg.id, { resolve, reject, timer: timer as ReturnType<typeof setTimeout>, destAppId })
      // A packet that never left cannot be answered, so waiting for a response is waiting for nothing. This
      // matters most for `request`, whose timeout is -1 by design (the framework has no idea how long a
      // business call takes) — without this check a request to a mistyped or just-disconnected appId would hang
      // forever rather than fail. The three ways it can fail (no-route / self-addressed / send-failed) are on
      // `nacp:internal:route:error`; the rejection states only the fact, since one code per cause would push
      // routing vocabulary into every caller's catch.
      if (!this.outbound(msg)) {
        this.pendingTable.settle(msg.id)
        reject(nacpOutbound('not-sent', `${msg.type} ${msg.id} to '${msg.to}' was never sent — see nacp:internal:route:error`))
      }
    })
  }

  /**
   * The one bridge from a local bus hit to an outbound notify — shared by explicit subscribe and by the
   * responding side's auto-subscription, so both behave identically.
   *
   * targetSubName is captured in the closure (known at subscribe time); hitSubName is EventBus's second
   * callback argument, because a wildcard subscription cannot tell from its own pattern which concrete name
   * fired.
   */
  private registerForwardingListener(parentId: string, subscriber: string, targetSubName: string): string {
    return this.napp.bus.listen(targetSubName, (payload: any, hitSubName: string) => {
      // Fire-and-forget: a bus listener has nobody to hand a promise to, and a notify that has to wait for an
      // offline peer must not hold up the emit that produced it.
      void this.notify(subscriber, { parentId, targetSubName, hitSubName, payload })
    })
  }

  // ── the App link lifecycle: online → offline → gone ──

  /**
   * An App became unreachable. This is the ONLY response to an unexpected loss, whether the socket dropped or
   * an ack simply never came: both mean "cannot reach it right now", and neither means "it is never coming
   * back". So nothing is torn down here.
   *
   * Three things happen, and the order matters:
   *   1. the link is marked offline, snapshotting what the grace expiry will need to decide
   *   2. whatever was awaiting an ack goes back to the FRONT of the backlog — it left the wire before anything
   *      queued behind it, so replaying it first is what preserves the order it originally had
   *   3. the grace clock starts
   *
   * Subscriptions are deliberately left running. A peer that returns within the window finds its process
   * stream intact, and the notifies produced while it was away are in the backlog waiting for it — which is
   * the whole reason a backlog exists rather than a bare retransmit cache. An async iterable handed out by
   * `NApp.subscribe` therefore does NOT end on a blip; consumers learn about reachability from
   * `nacp:internal:napp:success` instead.
   */
  private markOffline(appId: string) {
    if (!this.peerAppTable.markOffline(appId)) return    // unknown, or already offline — the first snapshot wins
    const t = this.ackTimers.get(appId)
    if (t) { clearTimeout(t); this.ackTimers.delete(appId) }
    this.backlogTable.unshiftAll(this.ackPendingTable.drainByAppId(appId))
    this.armGraceTimer(appId)
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId, reason: 'offline' })
  }

  private armGraceTimer(appId: string) {
    const existing = this.graceTimers.get(appId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => { this.graceTimers.delete(appId); this.forget(appId, 'grace-expired') }, this.napp.reconnectGraceMs)
    t.unref?.()
    this.graceTimers.set(appId, t)
  }

  /**
   * An App came back. Cancel the countdown, then drain everything held for it — in insertion order, which
   * after markOffline's unshift puts the previously-unacked messages ahead of anything queued during the
   * outage.
   *
   * Called on a successful register, which is the only evidence that a peer is ready to receive again. Note
   * the binding itself has already been redone by `bindAppId`, so the link is `online` before this runs.
   */
  private resumeApp(appId: string) {
    const t = this.graceTimers.get(appId)
    if (t) { clearTimeout(t); this.graceTimers.delete(appId) }
    for (const rec of this.backlogTable.listByAppId(appId)) this.popOne(rec.msg.id)
  }

  /**
   * The App is gone for good: the grace window expired, or it said goodbye. Everything held for it is
   * discarded and every waiter fails — this is the one place that gives up on a message.
   *
   * NACT is treated separately from NACP, and only here. The protocol state always goes; the physical
   * connection goes only if it existed solely to serve this App:
   *
   *   this appId held the Gateway slot     → close the peer (its own link, and the relay everyone used)
   *   its peerId WAS the Gateway's peerId  → reached THROUGH the Gateway: leave the socket alone
   *   anything else                        → a direct link of its own: close it
   *
   * The middle case is why the decision needs the snapshot taken at disconnect: several appIds share a
   * Gateway's peerId, and clearing a Gateway's own appId also clears the slot, so by now "was this the
   * Gateway?" can no longer be asked of live state. Closing on that case would drop every OTHER App behind
   * the same relay — a single quiet App taking the whole network with it.
   */
  private forget(appId: string, reason: 'grace-expired' | 'unregistered') {
    const snapshot = this.peerAppTable.getSnapshot(appId)
    const peerId = snapshot?.peerId ?? this.peerAppTable.getPeerIdbyAppId(appId)
    const wasGateway = snapshot ? snapshot.gatewayAppId === appId : this.peerAppTable.getGatewayAppId() === appId
    const viaGateway = snapshot !== undefined && snapshot.gatewayPeerId !== undefined
      && snapshot.peerId === snapshot.gatewayPeerId && !wasGateway

    for (const t of [this.ackTimers.get(appId), this.graceTimers.get(appId)]) if (t) clearTimeout(t)
    this.ackTimers.delete(appId)
    this.graceTimers.delete(appId)

    // Give up on everything still queued, then tell each waiter, so no promise is left hanging on an App that
    // no longer exists.
    for (const rec of this.backlogTable.deleteByAppId(appId)) {
      this.settleDeparture(rec.msg.id, false)
      this.settleAck(rec.msg.id, false)
    }
    for (const rec of this.ackPendingTable.deleteByAppId(appId)) this.settleAck(rec.msg.id, false)
    this.inboundReceivedTable.deleteByAppId(appId)

    this._cleanupPeer(appId)
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId, reason: 'dropped' })

    // NACT last: closing the socket produces a disconnect event, and by now there is no link record left for
    // it to act on, so the two cannot chase each other. Idempotent either way — closePeer on an absent peer is
    // a no-op, and dropPeer only announces when it was the call that removed the row.
    if (peerId && !viaGateway) void this.napp.nact.closePeer(peerId)
    void reason
  }

  /** Drop the NACP-layer state one App owns. Not a lifecycle step of its own — `forget` is — but kept separate
   *  because `terminate` needs the same teardown without any of the per-App decisions around it. */
  private _cleanupPeer(appId: string) {
    this.peerAppTable.deleteAppIdbyAppId(appId)
    this.pendingTable.failFor(appId, `peer '${appId}' is gone`)
    // Both halves of every subscription touching that peer go, one table per direction:
    //   subs    — listeners we registered on ITS behalf; off them (this is SubscribeTable's whole purpose)
    //   listens — handlers waiting on notifies FROM it; nothing will ever arrive again, so drop them
    for (const rec of this.subscribeTable.deleteSubRecordbyAppId(appId)) if (rec.listenId) this.napp.bus.off(rec.listenId)
    this.listenTable.deleteListenRecordbyAppId(appId)
  }

  /** Physical disconnect → mark unreachable, nothing more. Private: nothing outside drives this, NACP
   *  subscribes to `nact:peer:disconnect` in its own constructor. The physical-disconnect semantic stays
   *  NACT's event; what it means for the protocol is `markOffline`.
   *
   *  EVERY appId on that peer, not just one: appIds reached through a Gateway share the Gateway's peerId, so
   *  handling a single one left the rest marked reachable over a connection that no longer exists. This is
   *  also the Gateway cascade — the relay going down takes everything behind it offline, because that is
   *  exactly what happened. */
  private onPeerDisconnect(peerId: NACTPeerId) {
    for (const appId of this.peerAppTable.listAppIdbyPeerId(peerId)) this.markOffline(appId)
  }

  // ── inbound ──

  inbound(msg: NACPMessage, peer: Peer) {
    // Fired unconditionally, before any processing — including to≠self, because the packet HAS logically
    // entered this NApp; whether to drop or forward it is a decision NACP makes afterwards.
    this.napp.bus.emit(inboundEvent(msg), { fromPeerId: peer.id, msg })

    if (msg.to !== this.napp.id) {
      // register never participates in forwarding: its `to` check asks only "is this handshake for me?".
      // A Gateway must not relay a misaddressed register — the sender simply times out (10s), which is
      // exactly how "you dialled the wrong App" is meant to surface.
      if (msg.type === 'register') {
        this.napp.bus.emit(NACPInternal.gatewayError, { msg, reason: 'dropped' })
        return
      }
      if (this.napp.isGateway && this.checkAppId(msg.to)) this.outbound(msg, { forwarded: true })
      else this.napp.bus.emit(NACPInternal.gatewayError, { msg, reason: 'dropped' })
      return
    }

    // An ack answers nothing and is answered by nothing — it settles a record and stops. Handled before the
    // ack-and-dedup layers below precisely so it cannot enter them: acking an ack is the infinite regress the
    // whole scheme rests on not doing.
    if (msg.type === 'ack') return this.onAck(msg)

    // Layer 1 — the protocol-level receipt, sent BEFORE any handling. It says "this arrived", which is a fact
    // about the wire, not about the work: the peer needs it to release its copy whether or not we go on to
    // find a consumer. Sending it before the dedup check is what makes a replay harmless — the copy is
    // acknowledged again (so the sender stops resending) but handled only once.
    //
    // register is the exception, and only because of ordering: there is no appId binding yet, so an ack here
    // would have no route. `onRegister` sends it down the inbound peer once the handshake passes.
    if (msg.type !== 'register') this.sendAck(msg)

    // Layer 2 — a replay of something already handled. Not an error: it means our earlier ack was lost, or the
    // link dropped before the sender saw it. Stopping here is what keeps handling exactly-once.
    if (expectsAck(msg.type) && this.inboundReceivedTable.has(msg.id)) return
    if (expectsAck(msg.type)) this.inboundReceivedTable.add(msg.id, msg.from)

    // Layer 3 — the business handling.
    switch (msg.type) {
      case 'register':    return this.onRegister(msg, peer)
      case 'unregister':  return this.onUnregister(msg)
      case 'response':    return this.onResponse(msg)
      case 'request':     return this.onRequest(msg)
      case 'signal':      return void this.onSignal(msg)
      case 'notify':      return this.onNotify(msg)
      case 'subscribe':   return this.onSubscribe(msg)
      case 'unsubscribe': return this.onUnsubscribe(msg)
    }
  }

  /**
   * Acknowledge one inbound message. Fire-and-forget by design: an ack expects nothing back, so there is
   * nothing to await and no failure worth reporting to a caller — if it cannot leave, the sender's own ack
   * timeout is what notices, which is exactly the signal that mechanism exists to produce.
   *
   * A register's ack is the one that cannot be routed by appId: the binding does not exist until the handshake
   * passes, so it goes straight down the peer it arrived on. Same reason its rejection response does.
   */
  private sendAck(msg: NACPMessage, peerId?: NACTPeerId) {
    const ack = this.build('ack', msg.from, { parentId: msg.id })
    if (msg.type === 'register' && peerId !== undefined) this.outbound(ack, { peerId })
    else this.outbound(ack)
  }

  /**
   * An inbound ack: the message it names has been received by the far end, so this side can let go of it.
   *
   * No consumer means the id is not one we are holding — a duplicate ack, or one for something already given
   * up on. Reported and dropped, never answered: replying would start a chain that has no terminal. This is
   * the ack-side twin of a response arriving with no waiter.
   */
  private onAck(msg: AckMessage) {
    const rec = this.ackPendingTable.settle(msg.meta.parentId)
    if (!rec) return void this.napp.bus.emit(NACPInternal.ackError, { msg, reason: 'has-no-consumer' })
    this.settleAck(rec.msg.id, true)
    // The clock is per-App and only needs to run while something is outstanding.
    this.rearmAckTimer(rec.destAppId)
  }

  private onRegister(msg: RegisterMessage, peer: Peer) {
    const from = msg.from
    const peerId = peer.id
    const reject = (reason: string) => {
      this.napp.bus.emit(NACPInternal.registerError, { fromPeerId: peerId, from, reason })
      // The appId table is not bound yet (binding happens only after all checks pass), so answer straight
      // down the inbound peerId rather than looking up msg.to.
      this.outbound(this.build('response', from, { parentId: msg.id, isOk: false, whyNotOk: reason }), { peerId })
      // Belt and braces: normally the rejected side reads whyNotOk and closes; if it misbehaves, we do.
      // `unref` so this never holds the process open: it is a defence against a peer that will not leave, and
      // if we are exiting anyway the connection dies with us — the goal is met without the wait. Left
      // fire-and-forget rather than tracked in a table, because a tracked timer would then need removing on
      // fire too, and a defensive close is not worth that bookkeeping.
      setTimeout(() => { try { peer.close() } catch { /* already gone */ } }, RESPONSE_TIMEOUT_MS).unref()
    }

    // register is internal traffic, so its fields live in the typed payload, not meta.
    const reg = msg.payload as RegisterPayload | undefined
    if (reg?.isGateway && this.napp.isGateway) return reject('dual-gateway')
    if (msg.v.major !== PROTOCOL_V.major) return reject('version-mismatch')
    // Reject the NEW one, keep the old: with one connection per App, evicting the old would let two
    // same-appId processes kick each other in a loop. The zombie case is handled by NACT disconnect detection.
    //
    // An OFFLINE appId is the opposite case and must not be refused: this register IS the reconnect the grace
    // window was held open for. Only a live binding is a conflict.
    if (this.peerAppTable.isOnline(from)) return reject('appId-in-use')
    const returning = this.peerAppTable.getState(from) === 'offline'

    this.bindAppId(from, peerId)
    // Whether this peer becomes our fallback is decided by ITS declaration, never by a local override.
    // A second declaring peer loses the race: downgraded to a plain link, or rejected outright.
    const gatewayVerdict = this.settleGatewayByDeclared(from, peerId, reg?.isGateway === true)
    if (gatewayVerdict === 'conflict') {
      this.dropAppId(from)          // roll back the bind we just did — this link is not going to live
      return reject('multi-gateway')
    }
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId: from, reason: 'bound', isGateway: gatewayVerdict === 'adopted' })
    // The handshake arrived over a peer that had no binding yet, so its ack could not be routed by appId at
    // the point `inbound` would normally have sent one. Now that the binding exists, it can go.
    this.sendAck(msg, peerId)
    // This response completes the symmetric exchange: our own decl + isGateway, so the dialler learns our
    // capabilities and whether we are the Gateway in the SAME round trip — no follow-up introduce needed.
    // Both belong only to this response, so they ride the typed payload rather than the shared meta.
    void this.response(from, { parentId: msg.id, isOk: true,
      payload: { isGateway: this.napp.isGateway, decl: this.napp.buildDecl() } satisfies RegisterResponsePayload })
    // Last, because it puts held traffic on the wire: the handshake answer should precede the backlog it
    // unblocks, or the peer would receive replayed messages before the response that says it is registered.
    if (returning) this.resumeApp(from)
  }

  /**
   * A peer is leaving on purpose. Unlike a disconnect this is not "unreachable for now" — the peer said it is
   * done, so there is nothing to hold for it and no grace window to run. Everything queued for it goes.
   *
   * The answer goes out BEFORE the cleanup, and the ordering is load-bearing twice over: the route must still
   * exist for the response to leave at all, and `forget` discards this App's queue — including anything not yet
   * on the wire. Answering first is what keeps the goodbye itself from being thrown away.
   *
   * Not awaited. Waiting for the ack of a response to an unregister would mean waiting for a peer that is
   * already tearing itself down; the response reaching the wire is as much confirmation as this exchange can
   * have. Its own ack, if it arrives, finds nothing and is reported as `has-no-consumer` — accurate, since by
   * then the record really is gone.
   */
  private onUnregister(msg: UnregisterMessage) {
    void this.response(msg.from, { parentId: msg.id, isOk: true })
    this.forget(msg.from, 'unregistered')
  }

  /**
   * A response arrived: settle its waiter.
   *
   * AutoSub closing half: the arrival of an event request's response IS the arrival of the virtual unsubscribe
   * (both sides agreed to skip sending it), so this is where that packet lands. `meta.kind === 'event'` says
   * "this answers an event request" and `meta.parentId` is that request's id — which is the AutoSub's subId.
   * `to` is `msg.from`: the peer we subscribed on. Nothing goes out, so no route is needed for it.
   */
  private onResponse(msg: ResponseMessage) {
    if (msg.meta.kind === 'event') this.unsubscribe(msg.from, msg.meta.parentId, { autoSub: true })
    const e = this.pendingTable.settle(msg.meta.parentId)
    if (!e) return void this.napp.bus.emit(NACPInternal.responseError, { msg, reason: 'has-no-consumer' })
    if (msg.meta.isOk) e.resolve(msg)
    else e.reject(nacpInbound('response-not-ok', msg.meta.whyNotOk ?? 'response isOk=false'))
  }

  /**
   * A request arrived: this is the binding layer, and it is thin by design. Find the Processor bound to that
   * kind, push the request in, and turn its two callbacks into bus events.
   *
   * The callbacks emit rather than notifying point-to-point. That single indirection is what makes subscribe
   * uniform: the requester's auto-subscription and any third-party observer both just match a bus name.
   *
   * AUTO-SUBSCRIPTION for event kinds: we call `onSubscribe` with a simulated subscribe message — exactly the
   * same code path as an external subscribe, just without a message crossing the wire and without sending back a
   * subscribeResponse. The simulated message provides `id=reqId`, `from=msg.from`, and `targetSubName` derived
   * from the reqId, so SubscribeTable records are identical in shape. The matching half on the requesting side
   * is the local `ListenTable` record that `request()` built via `subscribe(autoSub:true)`.
   */
  private onRequest(msg: RequestMessage) {
    const kind = msg.meta.kind

    const proc: Processor | undefined = this.napp.getProcessor(kind)
    if (!proc) {
      this.napp.bus.emit(NACPInternal.requestError, { msg, reason: 'no-processor' })
      // Statement, not `return this.response(...)`: response reports delivery, and letting that escape here
      // would leak it into `inbound`'s return type, which has no meaning to give a caller.
      void this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: `no-processor for kind '${kind}'`, kind })
      return
    }

    const reqId = msg.id
    // event ONLY: register the forwarding listener before pushing, so a synchronous Processor isn't missed.
    // This is the other half of AutoSub — a virtual subscribe that creates a real SubscribeTable record.
    if (kind === 'event') {
      this.onSubscribe({ id: reqId, from: msg.from, payload: { targetSubName: callProcessName(kind, reqId) } } as SubscribeMessage, { autoSub: true })
    }

    proc.push(
      { target: msg.meta.target ?? '', payload: msg.payload, reqId },
      {
        // No thisArg: the forwarding listener reads the concrete fired name off EventBus's second callback
        // argument, so nothing has to be smuggled through `this`.
        onProcess: (chunk) => { this.napp.bus.emit(callProcessName(kind, reqId), chunk) },
        onResponse: (result, isOk, whyNotOk) => {
          this.napp.bus.emit(callResponseName(kind, reqId), { result, isOk, whyNotOk })
          // The AutoSub's closing half rides this response's own outbound — see response().
          void this.response(msg.from, { parentId: reqId, isOk, whyNotOk, kind, payload: result })
        },
      },
    )
  }

  private async onSignal(msg: SignalMessage): Promise<void> {
    this.napp.bus.emit(eventSignalName(msg.meta.parentId), msg)
    const proc = this.napp.getProcessor('event')
    if (!proc) {
      this.napp.bus.emit(NACPInternal.signalError, { msg, reason: 'no-event-processor' })
      return
    }
    try {
      await proc.signal(msg.meta.kind === 'normal'
        ? { signalId: msg.id, reqId: msg.meta.parentId, kind: 'normal', payload: msg.payload }
        : { signalId: msg.id, reqId: msg.meta.parentId, kind: msg.meta.kind })
    } catch {
      this.napp.bus.emit(NACPInternal.signalError, { msg, reason: 'processor-rejected' })
    }
  }

  /**
   * An inbound notify. Looked up from ListenTable by parentId — whether the subscription was created by an
   * explicit `subscribe()` or by the local half of AutoSub (`subscribe(autoSub:true)`), the record is the
   * same, so there is only ONE lookup path here.
   *
   * Note: a notify does NOT settle the pending entry — it is a push, not the terminal. The requester's
   * terminal is the response message (which delivers the result in full). A third party that explicitly
   * subscribed the wildcard DOES receive a copy of the terminal result here, which is exactly what it
   * asked for.
   */
  private onNotify(msg: NotifyMessage) {
    const parentId = msg.meta.parentId

    const rec = this.listenTable.getListenRecordbySubId(parentId)
    if (rec) return rec.targetListener(msg.payload, msg)

    this.napp.bus.emit(NACPInternal.notifyError, { msg, reason: 'has-no-consumer' })
  }

  /**
   * subscribe == a remote listen. Register the requested name on our own bus; every hit is packed into a
   * notify addressed to the subscriber. The listenId is kept so unsubscribe (and disconnect) can `off` it.
   *
   * When `{ autoSub: true }`, this is the responding half of an auto-subscription — the listener is real and
   * the SubscribeTable record is real, but no subscribe message crossed the wire so we do NOT send back a
   * subscribeResponse. AutoSub is answered through the request's own response/notify, not here.
   */
  private onSubscribe(msg: SubscribeMessage, { autoSub = false }: { autoSub?: boolean } = {}) {
    const subId = msg.id
    const subscriber = msg.from
    const targetSubName = (msg.payload as SubscribePayload)?.targetSubName

    // Malformed-field guard: a subscribe missing targetSubName would otherwise reach bus.listen(undefined),
    // whose key.split(':') throws — and that throw propagates out of inbound() into NACT's peer path, which
    // treats it as a framing fault and tears the connection down. So one bad frame drops a whole connection.
    // Reject it in-band instead (emit + isOk:false response), the same shape as onRegister's refusal, so the
    // peer learns why in ~10ms instead of waiting out the 10s handshake timeout, and the link stays up.
    if (typeof targetSubName !== 'string' || !targetSubName) {
      this.napp.bus.emit(NACPInternal.subscribeError, { msg, reason: 'bad-target-sub-name' })
      if (!autoSub) {
        void this.response(subscriber, {
          parentId: subId,
          isOk: false,
          whyNotOk: 'bad-target-sub-name',
        })
      }
      return
    }

    const listenId = this.registerForwardingListener(subId, subscriber, targetSubName)
    this.subscribeTable.add({ subId, appId: subscriber, listenId, targetSubName })
    // `targetSubId` under the name the cancelling unsubscribe will use, so the subscriber can hand it straight
    // back. Same value as parentId — see SubscribeResponsePayload for why it is stated anyway.
    if (!autoSub)
      void this.response(subscriber, {
        parentId: subId, isOk: true, payload: { targetSubId: subId } satisfies SubscribeResponsePayload,
      })
  }

  /**
   * unsubscribe == a remote off.
   *
   * When `{ autoSub: true }`, this is the closing half of an auto-subscription: the SubscribeTable record and
   * its listener are real, so they are dropped exactly as an external unsubscribe would drop them — but no
   * unsubscribe message ever arrived, so nothing is answered. A missing record is not a protocol error either
   * (the peer may have gone away first, taking it with it via _cleanupPeer), so it stays silent rather than
   * emitting error:subscribe.
   */
  private onUnsubscribe(msg: UnsubscribeMessage, { autoSub = false }: { autoSub?: boolean } = {}) {
    const rec = this.subscribeTable.deleteSubRecordbySubId((msg.payload as UnsubscribePayload).targetSubId)
    if (!rec) {
      if (autoSub) return
      this.napp.bus.emit(NACPInternal.subscribeError, { msg, reason: 'unknown-subscription' })
      // Statement, not `return this.response(...)` — see onRequest: keep response's result out of inbound's
      // return type.
      void this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: 'unknown-subscription' })
      return
    }
    if (rec.listenId) this.napp.bus.off(rec.listenId)
    if (!autoSub) void this.response(msg.from, { parentId: msg.id, isOk: true })
  }

  /** Tear down everything this layer holds: fail every waiter, off every listener, clear every table.
   *  Named `terminate` because all three stack members name their full teardown that — NApp stops the App,
   *  NACT drops every connection, NACP clears every table. NACP has no handle to close, only state to drop. */
  terminate() {
    this.pendingTable.failAll('nacp terminate')
    for (const rec of this.subscribeTable.listSubRecord()) if (rec.listenId) this.napp.bus.off(rec.listenId)
    this.subscribeTable.clear()
    this.listenTable.clear()
    this.peerAppTable.clear()
    // Every clock, then every queue — and each abandoned message tells its waiter, so shutting down cannot
    // leave a promise pending on a table that no longer exists.
    for (const t of this.ackTimers.values()) clearTimeout(t)
    for (const t of this.graceTimers.values()) clearTimeout(t)
    this.ackTimers.clear()
    this.graceTimers.clear()
    for (const rec of [...this.backlogTable.clear(), ...this.ackPendingTable.clear()]) {
      this.settleDeparture(rec.msg.id, false)
      this.settleAck(rec.msg.id, false)
    }
    this.inboundReceivedTable.clear()
    for (const resolve of this.departureWaiters.values()) resolve(false)
    for (const w of this.ackWaiters.values()) w.resolve(false)
    this.departureWaiters.clear()
    this.ackWaiters.clear()
  }
}
