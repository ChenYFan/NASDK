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
  BuildOpt, NACPMessage, NACPType, NotifyMessage, RegisterMessage, RegisterPayload, RegisterResponsePayload,
  SubscribePayload, SubscribeResponsePayload, UnsubscribePayload,
  RequestKind, RequestMessage, ResponseMessage, SubscribeMessage, UnregisterMessage, UnsubscribeMessage,
} from './types.ts'
import { PROTOCOL_V, buildMessage } from './types.ts'
import { ListenTable, PeerAppConnectionTable, ResponsePendingTable, SubscribeTable } from './tables.ts'
import {
  NACPInternal, callProcessName, callResponseName,
  inboundEvent, outboundEvent, type EmitContext,
} from './events.ts'
import { NACPError, nacpInbound, nacpOutbound } from './errors.ts'
import { NACTEvent } from '../NACT/events.ts'

const RESPONSE_TIMEOUT_MS = 10000          // register / subscribe / unsubscribe: protocol handshakes, must be fast
const REQUEST_TIMEOUT_MS  = -1             // request: business call — framework has no idea how long it takes; -1 = no timeout

export class NACP {
  private peerAppTable = new PeerAppConnectionTable()
  private pendingTable = new ResponsePendingTable()
  private subscribeTable = new SubscribeTable()   // subscribed side: who subscribed to my bus → notify OUTBOUND
  private listenTable = new ListenTable()         // subscribing side: my own listeners → notify INBOUND
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
    this.napp.bus.listen(NACTEvent.peerDisconnect, ({ peerId }: { peerId: NACTPeerId }) => {
      this.onPeerDisconnect(peerId)
    })
  }

  // ── appId↔peerId table (the one irreducible mapping: logical name → physical connection) ──
  bindAppId(appId: string, peerId: NACTPeerId) { this.peerAppTable.bind(appId, peerId) }
  checkAppId(appId: string): boolean { return this.peerAppTable.has(appId) }
  dropAppId(appId: string) { this.peerAppTable.deleteAppIdbyAppId(appId) }
  listAppId(): string[] { return this.peerAppTable.listAppId() }
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
   *                    stays usable as a plain App link (this is how a NAT-style node holds two Gateways)
   *   'conflict'     — same, but the switch is OFF: the caller must unregister and drop the link
   */
  settleGatewayByDeclared(appId: string, peerId: NACTPeerId, peerDeclaredGateway: boolean):
    'not-declared' | 'adopted' | 'downgraded' | 'conflict' {
    if (!peerDeclaredGateway) return 'not-declared'
    if (this.peerAppTable.setGateway(peerId)) return 'adopted'
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
   * The public outbound face: resolve the destination peer, announce, hand to NACT.
   *
   * Routing is three-tier (direct connection wins, Gateway is the fallback):
   *   1. an explicit opt.peerId  — used when the appId table cannot help yet (a register rejection, where
   *      binding happens only after validation passes, so we answer straight down the inbound peer)
   *   2. a direct connection to msg.to
   *   3. the Gateway peer (the star centre is 1 hop from everyone, so it always knows the destination)
   * Nothing left → nacp:internal:route:error.
   *
   * opt.forwarded marks a Gateway passing a foreign packet through. It DUAL-fires: the physical
   * nacp:outbound:{type} (so "everything leaving this App" stays complete) plus route:forwarded (the
   * forwarding semantic). Two different questions, both worth answering.
   *
   * Returns whether the message actually reached NACT. The three failures — self-addressed, no-route,
   * send-failed — each already emit nacp:internal:route:error, so an OBSERVER learns the exact cause from
   * the bus; the boolean is for the CALLER, which otherwise had no way to tell a delivered packet from a
   * dropped one. Same shape as NACT.sendToPeer, which this forwards to.
   */
  outbound(msg: NACPMessage, opt?: { peerId?: NACTPeerId; forwarded?: boolean }): boolean {
    const toPeerId = opt?.peerId ?? this.peerAppTable.getPeerIdbyAppId(msg.to) ?? this.peerAppTable.getGatewayPeerId()
    this.napp.bus.emit(outboundEvent(msg), { toPeerId, msg })
    if (opt?.forwarded) this.napp.bus.emit(NACPInternal.gatewaySuccess, { toPeerId, msg, reason: 'forwarded' })
    // Addressed to ourselves: there is no wire to put it on. Checked BEFORE the peer is used and alongside
    // no-route rather than ahead of the event, so every attempt to leave is observable. Without it the packet
    // would miss the appId sheet — an App is never a key in its own — and fall through to the Gateway, which
    // knows us and would forward it straight back: a round trip ending in local delivery, not the no-op asked for.
    if (msg.to === this.napp.id) {
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'self-addressed' })
      return false
    }
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
    opt: { kind: RequestKind; target?: string; payload?: any; onProcess?: (chunk: any) => void },
  ): Promise<ResponseMessage> {
    const msg = this.build('request', to, { kind: opt.kind, target: opt.target, payload: opt.payload }) as RequestMessage
    // event ONLY: ability produces no process stream by definition, so there is nothing to subscribe.
    // Gated on kind ALONE — the same condition the responding side uses, because that is all it can see in the
    // request. An absent onProcess is a listener of `() => {}`, never a missing subscription: were this gated
    // on onProcess too, the peer would still attach its half and notify into a subscription we never filed.
    if (opt.kind === 'event') {
      this.subscribe(to, callProcessName(opt.kind, msg.id), opt.onProcess, { subId: msg.id, autoSub: true })
    }
    return this.Send4Response(msg, to)
  }

  /** Returns whether the notify reached NACT. False means it was never sent (no route, or the peer is gone) —
   *  the cause is on nacp:internal:route:error. A notify is one-way, so this boolean is the ONLY signal a
   *  caller gets; there is no response coming to reveal the failure later. */
  notify(to: string, opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any }): boolean {
    return this.outbound(this.build('notify', to, opt))
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
   * Returns whether the response reached NACT. The AutoSub teardown runs EITHER WAY — the SubscribeTable half
   * being closed is ours, so it must go even when the packet could not leave, or a dead peer would leak a
   * listener on our own bus.
   */
  response(
    to: string,
    opt: { parentId: string; isOk: boolean; whyNotOk?: string; kind?: RequestKind; payload?: any },
  ): boolean {
    const sent = this.outbound(this.build('response', to, opt))
    if (opt.kind === 'event') {
      this.onUnsubscribe({ id: opt.parentId, from: to, payload: { targetSubId: opt.parentId } } as UnsubscribeMessage, { autoSub: true })
    }
    return sent
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
      this.outbound(msg)
    })
  }

  /**
   * The one bridge from a local bus hit to an outbound notify — shared by explicit subscribe and by the
   * responding side's auto-subscription, so both behave identically.
   *
   * targetSubName is captured in the closure (known at subscribe time); hitSubName arrives via the emitter's
   * thisArg, because a wildcard subscription cannot tell from its own pattern which concrete name fired.
   */
  private registerForwardingListener(parentId: string, subscriber: string, targetSubName: string): string {
    const self = this
    return this.napp.bus.listen(targetSubName, function (this: any, payload: any) {
      const hitSubName: string = this?.hitSubName ?? targetSubName
      self.notify(subscriber, { parentId, targetSubName, hitSubName, payload })
    })
  }

  // ── peer cleanup (disconnect or inbound unregister) ──

  private _cleanupPeer(appId: string) {
    this.peerAppTable.deleteAppIdbyAppId(appId)
    this.pendingTable.failFor(appId, `peer '${appId}' disconnected`)
    // Both halves of every subscription touching that peer go, one table per direction:
    //   subs    — listeners we registered on ITS behalf; off them (this is SubscribeTable's whole purpose)
    //   listens — handlers waiting on notifies FROM it; nothing will ever arrive again, so drop them
    for (const rec of this.subscribeTable.deleteSubRecordbyAppId(appId)) if (rec.listenId) this.napp.bus.off(rec.listenId)
    this.listenTable.deleteListenRecordbyAppId(appId)
  }

  /** Physical disconnect → NACP-layer cleanup. Private: nothing outside drives this, NACP subscribes to
   *  `nact:peer:disconnect` in its own constructor. The physical-disconnect semantic stays NACT's event;
   *  what it means for the protocol (drop the appId, fail its waiters, off its listeners) is this. */
  private onPeerDisconnect(peerId: NACTPeerId) {
    const appId = this.peerAppTable.getAppIdbyPeerId(peerId)
    if (!appId) return
    this._cleanupPeer(appId)
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId, reason: 'dropped' })
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

    switch (msg.type) {
      case 'register':    return this.onRegister(msg, peer)
      case 'unregister':  return this.onUnregister(msg)
      case 'response':    return this.onResponse(msg)
      case 'request':     return this.onRequest(msg)
      case 'notify':      return this.onNotify(msg)
      case 'subscribe':   return this.onSubscribe(msg)
      case 'unsubscribe': return this.onUnsubscribe(msg)
    }
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
      setTimeout(() => { try { peer.close() } catch { /* already gone */ } }, RESPONSE_TIMEOUT_MS)
    }

    // register is internal traffic, so its fields live in the typed payload, not meta.
    const reg = msg.payload as RegisterPayload | undefined
    if (reg?.isGateway && this.napp.isGateway) return reject('dual-gateway')
    if (msg.v.major !== PROTOCOL_V.major) return reject('version-mismatch')
    // Reject the NEW one, keep the old: with one connection per App, evicting the old would let two
    // same-appId processes kick each other in a loop. The zombie case is handled by NACT disconnect detection.
    if (this.checkAppId(from)) return reject('appId-in-use')

    this.bindAppId(from, peerId)
    // Whether this peer becomes our fallback is decided by ITS declaration, never by a local override.
    // A second declaring peer loses the race: downgraded to a plain link, or rejected outright.
    const gatewayVerdict = this.settleGatewayByDeclared(from, peerId, reg?.isGateway === true)
    if (gatewayVerdict === 'conflict') {
      this.dropAppId(from)          // roll back the bind we just did — this link is not going to live
      return reject('multi-gateway')
    }
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId: from, reason: 'bound', isGateway: gatewayVerdict === 'adopted' })
    // This response completes the symmetric exchange: our own decl + isGateway, so the dialler learns our
    // capabilities and whether we are the Gateway in the SAME round trip — no follow-up introduce needed.
    // Both belong only to this response, so they ride the typed payload rather than the shared meta.
    this.response(from, { parentId: msg.id, isOk: true,
      payload: { isGateway: this.napp.isGateway, decl: this.napp.buildDecl() } satisfies RegisterResponsePayload })
  }

  private onUnregister(msg: UnregisterMessage) {
    // Answer BEFORE cleanup, while the outbound route still exists.
    this.response(msg.from, { parentId: msg.id, isOk: true })
    this._cleanupPeer(msg.from)
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId: msg.from, reason: 'dropped' })
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
      // Statement, not `return this.response(...)`: response now reports a boolean, and letting it escape
      // here would leak that into `inbound`'s return type, which has no meaning to give a caller.
      this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: `no-processor for kind '${kind}'`, kind })
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
        onProcess: (chunk) => {
          const name = callProcessName(kind, reqId)
          // thisArg carries the concrete fired name so a wildcard subscriber can fill hitSubName.
          this.napp.bus.emit(name, chunk, { hitSubName: name } satisfies EmitContext)
        },
        onResponse: (result, isOk, whyNotOk) => {
          const name = callResponseName(kind, reqId)
          this.napp.bus.emit(name, { result, isOk, whyNotOk }, { hitSubName: name } satisfies EmitContext)
          // The AutoSub's closing half rides this response's own outbound — see response().
          this.response(msg.from, { parentId: reqId, isOk, whyNotOk, kind, payload: result })
        },
      },
    )
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
    const targetSubName = (msg.payload as SubscribePayload).targetSubName

    const listenId = this.registerForwardingListener(subId, subscriber, targetSubName)
    this.subscribeTable.add({ subId, appId: subscriber, listenId, targetSubName })
    // `targetSubId` under the name the cancelling unsubscribe will use, so the subscriber can hand it straight
    // back. Same value as parentId — see SubscribeResponsePayload for why it is stated anyway.
    if (!autoSub)
      this.response(subscriber, {
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
      // Statement, not `return this.response(...)` — see onRequest: keep response's boolean out of inbound's
      // return type.
      this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: 'unknown-subscription' })
      return
    }
    if (rec.listenId) this.napp.bus.off(rec.listenId)
    if (!autoSub) this.response(msg.from, { parentId: msg.id, isOk: true })
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
  }
}
