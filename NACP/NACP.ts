/**
 * NACP — the protocol face, one of NASDK's three parallel stack members (NApp / NACP / NACT). It regulates
 * what a message looks like, how a request pairs
 * with its response, and how addressing fields are stamped. It is an envelope-format spec plus pairing
 * semantics — NOT a post office: it does not forward (that is the App's inbound behaviour), does not know
 * about connections (that is NACT), and never interprets payload.
 *
 * Owns three connection-level tables (see tables.ts), all forward-lookup only. Reaches everything else
 * through its ref box: the shared bus (emit/listen/off), the App's identity and declaration, the bound
 * Processors, and its sibling NACT's single outbound face (sendToPeer).
 *
 * ── subscribe/notify: a REMOTE EventBus subscription machine ─────────────────────────────────────────
 * subscribe is not a mechanism of its own. It means "register a listener on YOUR NApp EventBus for me, and
 * forward whatever it catches to me as a notify". Apart from crossing a process boundary it is exactly a
 * local `bus.listen`:
 *
 *     bus.listen(name, cb) → listenId   ⇔   subscribe(to, targetSubName) → subId
 *     bus.off(listenId)                 ⇔   unsubscribe(targetSubId)
 *     cb fires                          ⇔   notify{parentId=subId, hitSubName} arrives
 *     emit(name, payload)               ⇔   the subscribed side packs a notify and sends it out
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
import type { NACPPrivateRef } from '../NApp/types.ts'
import type {
  BuildOpt, Declaration, NACPMessage, NACPType, NotifyMessage, RegisterMessage,
  RequestKind, RequestMessage, ResponseMessage, SubscribeMessage, UnsubscribeMessage,
} from './types.ts'
import { PROTOCOL_V, buildMessage } from './types.ts'
import { PeerAppConnectionTable, ResponsePendingTable, SubscribeTable } from './tables.ts'
import {
  NACPInternal, callProcessName, callResponseName,
  inboundEvent, outboundEvent, type EmitContext,
} from './events.ts'
import { nacpInbound, nacpOutbound } from './errors.ts'

const RESPONSE_TIMEOUT_MS = 10000          // register / subscribe / unsubscribe: protocol handshakes, must be fast
const REQUEST_TIMEOUT_MS  = -1             // request: business call — framework has no idea how long it takes; -1 = no timeout

export class NACP {
  private conn = new PeerAppConnectionTable()
  private pending = new ResponsePendingTable()
  private subs = new SubscribeTable()
  private ref: NACPPrivateRef

  constructor(ref: NACPPrivateRef) { this.ref = ref }

  // ── appId↔peerId table (the one irreducible mapping: logical name → physical connection) ──
  bindAppId(appId: string, peerId: NACTPeerId, isGateway = false) { this.conn.bind(appId, peerId, isGateway) }
  hasAppId(appId: string): boolean { return this.conn.has(appId) }
  dropAppId(appId: string) { this.conn.drop(appId) }
  appIds(): string[] { return this.conn.appIds() }
  appToPeerId(appId: string): NACTPeerId | undefined { return this.conn.peerId(appId) }
  /** Observation: how many subscriptions this NACP currently serves (used by tests / diagnostics). */
  subCount(): number { return this.subs.size() }
  pendingCount(): number { return this.pending.size() }

  // ── build ──

  private build(type: NACPType, to: string, opt: BuildOpt = {}): NACPMessage {
    // register always carries this App's own identity fields; callers never supply them.
    if (type === 'register') opt = { ...opt, isGateway: this.ref.isGateway, decl: this.ref.buildDecl() }
    return buildMessage(this.ref.selfId, type, to, opt)
  }

  /**
   * The public outbound face: resolve the destination peer, announce, hand to NACT.
   *
   * Routing is three-tier (direct connection wins, Gateway is the fallback):
   *   1. an explicit opt.peerId  — used when the appId table cannot help yet (a register rejection, where
   *      binding happens only after validation passes, so we answer straight down the inbound peer)
   *   2. a direct connection to msg.to
   *   3. the Gateway peer (the star centre is 1 hop from everyone, so it always knows the destination)
   * Nothing left → nacp:internal:error:route.
   *
   * opt.forwarded marks a Gateway passing a foreign packet through. It DUAL-fires: the physical
   * nacp:outbound:{type} (so "everything leaving this App" stays complete) plus route:forwarded (the
   * forwarding semantic). Two different questions, both worth answering.
   */
  outbound(msg: NACPMessage, opt?: { peerId?: NACTPeerId; forwarded?: boolean }) {
    const toPeerId = opt?.peerId ?? this.conn.peerId(msg.to) ?? this.conn.gatewayPeerId()
    this.ref.emit(outboundEvent(msg), { toPeerId, msg })
    if (opt?.forwarded) this.ref.emit(NACPInternal.routeForwarded, { toPeerId, msg })
    if (!toPeerId) {
      this.ref.emit(NACPInternal.errorRoute, { msg, reason: 'no-route' })
      return
    }
    if (!this.ref.sendToPeer(toPeerId, msg))
      this.ref.emit(NACPInternal.errorRoute, { msg, reason: 'send-failed' })
  }

  // ── outbound helpers ──

  /**
   * Send a request and await its ONE terminal response.
   *
   * AUTO-SUBSCRIPTION (this is the whole of it — there is no hidden mechanism): for event/ability kinds we
   * register an ordinary subscription on `nacp:{kind}:{reqId}:*` right here. It goes into the same
   * SubscribeTable, is forwarded by the same notify path, and is `off`'d when the terminal arrives. The only
   * differences from an externally-sent subscribe are that no subscribe MESSAGE exists, the name is derived
   * from the reqId, and notifies carry parentId=reqId. This is what used to be described as the "Hacky
   * exemption that notify may answer a request directly" — it is now just a subscription like any other.
   *
   * `onProcess` is the initiator-side sink for the process stream flowing back from that subscription.
   */
  request(
    to: string,
    opt: { kind: RequestKind; target?: string; payload?: any; onProcess?: (chunk: any) => void },
  ): Promise<ResponseMessage> {
    const msg = this.build('request', to, { kind: opt.kind, target: opt.target, payload: opt.payload }) as RequestMessage
    return this.sendAndAwait(msg, to, opt.onProcess)
  }

  notify(to: string, opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any }): void {
    this.outbound(this.build('notify', to, opt))
  }

  response(
    to: string,
    opt: { parentId: string; isOk: boolean; whyNotOk?: string; kind?: RequestKind; decl?: Declaration; isGateway?: boolean; payload?: any },
  ): void {
    this.outbound(this.build('response', to, opt))
  }

  register(to: string): Promise<ResponseMessage> {
    return this.sendAndAwait(this.build('register', to) as RegisterMessage, to)
  }

  unregister(to: string): Promise<ResponseMessage> {
    return this.sendAndAwait(this.build('unregister', to), to)
  }

  /** Subscribe on a peer's bus. Resolves with the confirming response; the caller keeps `subId` (= the
   *  subscribe message id) to unsubscribe later, and registers a local sink for the arriving notifies. */
  subscribe(to: string, targetSubName: string, onNotify?: (payload: any, msg: NotifyMessage) => void): Promise<ResponseMessage> {
    const msg = this.build('subscribe', to, { targetSubName }) as SubscribeMessage
    if (onNotify) this.localSinks.set(msg.id, onNotify)
    return this.sendAndAwait(msg, to).catch((e) => { this.localSinks.delete(msg.id); throw e })
  }

  /** Cancel a subscription on a peer (a remote `off`). Also drops the local notify sink. */
  unsubscribe(to: string, targetSubId: string): Promise<ResponseMessage> {
    const msg = this.build('unsubscribe', to, { targetSubId }) as UnsubscribeMessage
    this.localSinks.delete(targetSubId)
    return this.sendAndAwait(msg, to)
  }

  /** Initiator-side notify sinks: subId → callback. The mirror of the subscribed side's SubscribeTable —
   *  one lives where the subscription was REQUESTED, the other where the listener actually runs. */
  private localSinks = new Map<string, (payload: any, msg: NotifyMessage) => void>()

  private sendAndAwait(
    msg: NACPMessage, destAppId: string, onProcess?: (chunk: any) => void,
  ): Promise<ResponseMessage> {
    const isRequest = msg.type === 'request'
    const timeoutMs = isRequest ? REQUEST_TIMEOUT_MS : RESPONSE_TIMEOUT_MS
    return new Promise<ResponseMessage>((resolve, reject) => {
      const timer = timeoutMs < 0 ? undefined : setTimeout(() => {
        this.pending.settle(msg.id)
        this.dropAutoSub(msg.id)
        reject(nacpOutbound('timeout', `no response for ${msg.type} ${msg.id} within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.add(msg.id, { resolve, reject, timer: timer as ReturnType<typeof setTimeout>, destAppId, onProcess })
      // Auto-subscription: registered BEFORE the request goes out, so an immediate process notify has a sink.
      if (isRequest) {
        const kind = (msg as RequestMessage).meta.kind
        if (kind === 'event' || kind === 'ability') this.addAutoSub(msg.id, destAppId, kind)
      }
      this.outbound(msg)
    })
  }

  // ── auto-subscription bookkeeping ──
  //
  // An auto-subscription has two halves, and it matters which side holds which:
  //   · the REQUESTING side keeps only a local record (subId = reqId) so teardown is uniform; the process
  //     stream reaches it as inbound notifies, delivered through the pending entry's onProcess sink.
  //   · the RESPONDING side runs the actual listener, because that is where the call's events fire. It is
  //     registered through the same listen+notify path an external subscribe would take — which is the whole
  //     claim that "auto-subscription is not implicit, it is an ordinary subscription created for you".
  //
  // It subscribes the PROCESS name only. The requester is already awaiting the response message, which
  // delivers the finished result in full — it wants the process stream, not a second copy of the terminal
  // through the process door. Third parties remain free to subscribe the wildcard and get that copy.

  /** Requesting side: local record only, no listener (nothing fires here). */
  private addAutoSub(reqId: string, destAppId: string, kind: RequestKind) {
    this.subs.add({ subId: reqId, appId: destAppId, listenId: '', targetSubName: callProcessName(kind, reqId) })
  }

  /** Responding side: the real listener for this call, forwarding hits back to the requester.
   *
   *  It subscribes the PROCESS name, not the call's wildcard — the requester is already awaiting the response
   *  message, which delivers the finished result in full, so it only wants the process stream. A third party
   *  is welcome to subscribe the wildcard (or the `:response` name directly) and receive a copy of the
   *  result: that is a legitimate second surface, not a duplicate. The distinction is which DOOR a given
   *  consumer reads from — `await` for the requester's own terminal, notify for everyone observing. */
  private addServedAutoSub(reqId: string, requester: string, kind: RequestKind) {
    const targetSubName = callProcessName(kind, reqId)
    const listenId = this.registerForwardingListener(reqId, requester, targetSubName)
    this.subs.add({ subId: reqId, appId: requester, listenId, targetSubName })
  }

  private dropAutoSub(reqId: string) {
    const rec = this.subs.remove(reqId)
    if (rec?.listenId) this.ref.off(rec.listenId)
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
    return this.ref.listen(targetSubName, function (this: any, payload: any) {
      const hitSubName: string = this?.hitSubName ?? targetSubName
      self.notify(subscriber, { parentId, targetSubName, hitSubName, payload })
    })
  }

  // ── peer cleanup (disconnect or inbound unregister) ──

  private _cleanupPeer(appId: string) {
    this.conn.drop(appId)
    this.pending.failFor(appId, `peer '${appId}' disconnected`)
    // Off every listener registered on that peer's behalf — this is the SubscribeTable's whole purpose.
    for (const rec of this.subs.removeFor(appId)) if (rec.listenId) this.ref.off(rec.listenId)
  }

  /** Called by NApp on NACT's nact:peer:disconnect. The App goes offline at the NACP layer here; the
   *  physical-disconnect semantic itself stays NACT's event, kept separate on purpose. */
  onPeerDisconnect(peerId: NACTPeerId) {
    const appId = this.conn.appId(peerId)
    if (!appId) return
    this._cleanupPeer(appId)
    this.ref.emit(NACPInternal.nappOffline, { appId })
  }

  // ── inbound ──

  inbound(msg: NACPMessage, peer: Peer) {
    // Fired unconditionally, before any processing — including to≠self, because the packet HAS logically
    // entered this NApp; whether to drop or forward it is a decision NACP makes afterwards.
    this.ref.emit(inboundEvent(msg), { fromPeerId: peer.id, msg })

    if (msg.to !== this.ref.selfId) {
      // register never participates in forwarding: its `to` check asks only "is this handshake for me?".
      // A Gateway must not relay a misaddressed register — the sender simply times out (10s), which is
      // exactly how "you dialled the wrong App" is meant to surface.
      if (msg.type === 'register') {
        this.ref.emit(NACPInternal.routeDropped, { msg })
        return
      }
      if (this.ref.isGateway && this.hasAppId(msg.to)) this.outbound(msg, { forwarded: true })
      else this.ref.emit(NACPInternal.routeDropped, { msg })
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
      this.ref.emit(NACPInternal.errorRegister, { fromPeerId: peerId, from, reason })
      // The appId table is not bound yet (binding happens only after all checks pass), so answer straight
      // down the inbound peerId rather than looking up msg.to.
      this.outbound(this.build('response', from, { parentId: msg.id, isOk: false, whyNotOk: reason }), { peerId })
      // Belt and braces: normally the rejected side reads whyNotOk and closes; if it misbehaves, we do.
      setTimeout(() => { try { peer.close() } catch { /* already gone */ } }, RESPONSE_TIMEOUT_MS)
    }

    if (msg.meta.isGateway && this.ref.isGateway) return reject('dual-gateway')
    if (msg.v.major !== PROTOCOL_V.major) return reject('version-mismatch')
    // Reject the NEW one, keep the old: with one connection per App, evicting the old would let two
    // same-appId processes kick each other in a loop. The zombie case is handled by NACT disconnect detection.
    if (this.hasAppId(from)) return reject('appId-in-use')

    this.bindAppId(from, peerId, msg.meta.isGateway)
    this.ref.emit(NACPInternal.nappOnline, { appId: from, isGateway: msg.meta.isGateway })
    // The accept mirrors RegisterMeta: our own decl + isGateway, so the dialler learns our capabilities and
    // whether we are the Gateway in the SAME round trip — no follow-up introduce needed.
    this.response(from, { parentId: msg.id, isOk: true, decl: this.ref.buildDecl(), isGateway: this.ref.isGateway })
  }

  private onUnregister(msg: NACPMessage) {
    // Answer BEFORE cleanup, while the outbound route still exists.
    this.response(msg.from, { parentId: msg.id, isOk: true })
    this._cleanupPeer(msg.from)
    this.ref.emit(NACPInternal.nappOffline, { appId: msg.from })
  }

  private onResponse(msg: ResponseMessage) {
    const e = this.pending.settle(msg.meta.parentId)
    // A terminal arrived, so this call's auto-subscription is over.
    this.dropAutoSub(msg.meta.parentId)
    if (!e) return void this.ref.emit(NACPInternal.errorResponse, { msg, reason: 'has-no-consumer' })
    if (msg.meta.isOk) e.resolve(msg)
    else e.reject(nacpInbound('response-not-ok', msg.meta.whyNotOk ?? 'response isOk=false'))
  }

  /**
   * A request arrived: this is the binding layer, and it is thin by design. Find the Processor bound to that
   * kind, push the request in, and turn its two callbacks into bus events.
   *
   * The callbacks emit rather than notifying point-to-point. That single indirection is what makes subscribe
   * uniform: the requester's auto-subscription and any third-party observer both just match a bus name, so
   * neither the Processor nor NACP needs to know who is watching.
   *
   * AUTO-SUBSCRIPTION lives HERE, on the responding side — because this is where the events fire, so this is
   * where the listener must run. We register an ordinary subscription on this call's wildcard, addressed back
   * to the requester, through the very same path an external subscribe would take. The requester's own
   * bookkeeping entry (added in sendAndAwait) is just its local sink and timeout handle; the listener is ours.
   */
  private onRequest(msg: RequestMessage) {
    const kind = msg.meta.kind

    if (kind === 'introduce')
      return this.response(msg.from, { parentId: msg.id, isOk: true, kind: 'introduce', decl: this.ref.buildDecl() })

    const proc: Processor | undefined = this.ref.dispatch(kind)
    if (!proc) {
      this.ref.emit(NACPInternal.errorRequest, { msg, reason: 'no-processor' })
      // Every request gets an answer — never leave the peer hanging.
      return this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: `no-processor for kind '${kind}'`, kind })
    }

    const reqId = msg.id
    // Register the auto-subscription BEFORE pushing, so a Processor that reports synchronously is not missed.
    this.addServedAutoSub(reqId, msg.from, kind)

    proc.push(
      { target: msg.meta.target ?? '', payload: msg.payload, reqId },
      {
        onProcess: (chunk) => {
          const name = callProcessName(kind, reqId)
          // thisArg carries the concrete fired name so a wildcard subscriber can fill hitSubName.
          this.ref.emit(name, chunk, { hitSubName: name } satisfies EmitContext)
        },
        onResponse: (result, isOk, whyNotOk) => {
          const name = callResponseName(kind, reqId)
          this.ref.emit(name, { result, isOk, whyNotOk }, { hitSubName: name } satisfies EmitContext)
          this.response(msg.from, { parentId: reqId, isOk, whyNotOk, kind, payload: result })
          // The terminal ends this call's stream: off the listener we registered for it.
          this.dropAutoSub(reqId)
        },
      },
    )
  }

  /**
   * An inbound notify. Two shapes of sink, distinguished by what parentId points at:
   *   - a reqId  → the auto-subscription of a request WE sent: hand the payload to that call's onProcess.
   *                Crucially this does NOT settle the pending entry — a notify is a push, not the terminal.
   *   - a subId  → an explicit subscription WE requested: hand it to the sink registered at subscribe time.
   *
   * Note there is no filtering here, and none is needed: an auto-subscription subscribes only the PROCESS
   * name, so a terminal never arrives through this door for the requester. The requester's terminal is the
   * response message (which delivers the result in full); a third party that explicitly subscribed the
   * wildcard does receive a copy of the result here, which is exactly what it asked for.
   */
  private onNotify(msg: NotifyMessage) {
    const parentId = msg.meta.parentId

    const p = this.pending.get(parentId)
    if (p?.onProcess) return p.onProcess(msg.payload)

    const sink = this.localSinks.get(parentId)
    if (sink) return sink(msg.payload, msg)

    this.ref.emit(NACPInternal.errorNotify, { msg, reason: 'has-no-consumer' })
  }

  /**
   * subscribe == a remote listen. Register the requested name on our own bus; every hit is packed into a
   * notify addressed to the subscriber. The listenId is kept so unsubscribe (and disconnect) can `off` it.
   * Uses the same forwarding bridge as the responding side's auto-subscription — one path, one behaviour.
   */
  private onSubscribe(msg: SubscribeMessage) {
    const subId = msg.id
    const subscriber = msg.from
    const targetSubName = msg.meta.targetSubName

    const listenId = this.registerForwardingListener(subId, subscriber, targetSubName)
    this.subs.add({ subId, appId: subscriber, listenId, targetSubName })
    this.response(subscriber, { parentId: subId, isOk: true })
  }

  /** unsubscribe == a remote off. */
  private onUnsubscribe(msg: UnsubscribeMessage) {
    const rec = this.subs.remove(msg.meta.targetSubId)
    if (!rec) {
      this.ref.emit(NACPInternal.errorSubscribe, { msg, reason: 'unknown-subscription' })
      return this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: 'unknown-subscription' })
    }
    if (rec.listenId) this.ref.off(rec.listenId)
    this.response(msg.from, { parentId: msg.id, isOk: true })
  }

  /** Graceful shutdown: fail every waiter, off every listener, clear every table. */
  shutdown() {
    this.pending.failAll('nacp shutdown')
    for (const rec of this.subs.all()) if (rec.listenId) this.ref.off(rec.listenId)
    this.subs.clear()
    this.localSinks.clear()
    this.conn.clear()
  }
}
