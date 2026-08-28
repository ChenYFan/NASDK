/**
 * NACP — the protocol face of NASDK: message envelope, request/response pairing, addressing.
 * Never interprets payload; connections belong to NACT.
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

const RESPONSE_TIMEOUT_MS = 10000          // protocol handshakes
const REQUEST_TIMEOUT_MS  = -1             // business call, no timeout

/** notify / ack expect no ack — reaching the wire is their terminal. */
function expectsAck(type: NACPType): boolean { return type !== 'notify' && type !== 'ack' }

export class NACP {
  private peerAppTable = new PeerAppConnectionTable()
  private pendingTable = new ResponsePendingTable()
  private subscribeTable = new SubscribeTable()   // subscribed side: notify OUTBOUND
  private listenTable = new ListenTable()         // subscribing side: notify INBOUND
  /** Outbound stage 1: held while the destination is offline. */
  private backlogTable: OutboundBacklogTable
  /** Outbound stage 2: sent, waiting for ack. */
  private ackPendingTable: AckPendingTable
  /** Inbound message ids already handled (dedup). */
  private inboundReceivedTable: InboundReceivedTable
  /** One ack clock per App: first timeout marks the whole App offline. */
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** One grace clock per offline App; on fire the App is forgotten. */
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Resolvers awaiting departure of a specific message (notify/ack get no ack). */
  private departureWaiters = new Map<string, (sent: boolean) => void>()
  /** Resolvers awaiting ack of a specific outbound message. */
  private ackWaiters = new Map<string, { resolve: (ok: boolean) => void }>()
  napp: NApp

  constructor(napp: NApp) {
    this.napp = napp
    this.backlogTable = new OutboundBacklogTable(napp.queueMaxBytes, napp.queueMaxCount)
    this.ackPendingTable = new AckPendingTable(napp.queueMaxBytes, napp.queueMaxCount)
    this.inboundReceivedTable = new InboundReceivedTable(napp.queueMaxCount)
    this.napp.bus.listen(NACTEvent.peerDisconnect, ({ peerId }: { peerId: NACTPeerId }) => {
      this.onPeerDisconnect(peerId)
    })
  }

  // ── appId↔peerId table ──
  bindAppId(appId: string, peerId: NACTPeerId) { this.peerAppTable.bind(appId, peerId) }
  checkAppId(appId: string): boolean { return this.peerAppTable.has(appId) }
  dropAppId(appId: string) { this.peerAppTable.deleteAppIdbyAppId(appId) }
  /** Every appId this NACP still knows, reachable or not. */
  listAppId(): string[] { return this.peerAppTable.listAppId() }
  /** Only the ones reachable right now — what "connected" means to a caller. */
  listOnlineAppId(): string[] { return this.peerAppTable.listOnlineAppId() }
  getAppPeerId(appId: string): NACTPeerId | undefined { return this.peerAppTable.getPeerIdbyAppId(appId) }
  /** Which peer currently serves as this App's outbound fallback (undefined = none). */
  getGatewayPeerId(): NACTPeerId | undefined { return this.peerAppTable.getGatewayPeerId() }

  /** Settle the Gateway fallback slot for a freshly registered peer. First-come-first-served; a second
   *  declaring peer never clobbers it. Returns 'not-declared' | 'adopted' | 'downgraded' | 'conflict'
   *  ('conflict' → caller must unregister and drop the link). */
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

  /** Observation counters (tests / diagnostics). */
  getSubCount(): number { return this.subscribeTable.size() }
  getListenCount(): number { return this.listenTable.size() }
  getPendingCount(): number { return this.pendingTable.size() }

  // ── build ──

  private build(type: NACPType, to: string, opt: BuildOpt = {}): NACPMessage {
    // register always carries this App's own identity fields; callers never supply them.
    if (type === 'register') opt = { ...opt, isGateway: this.napp.isGateway, decl: this.napp.buildDecl() }
    return buildMessage(this.napp.id, type, to, opt)
  }

  /**
   * The public outbound face. Flow: backlog → [online? straight out] → ack-pending → [ack] → done.
   * Returns whether the message was ACCEPTED — a message held for an offline peer returns true.
   * False only for self-addressed / no-route / send-failed. For DEPARTURE await `send`.
   */
  outbound(msg: NACPMessage, opt?: { peerId?: NACTPeerId; forwarded?: boolean; retransmit?: boolean }): boolean {
    // Explicit peerId bypasses both stages (register rejection: no binding exists yet).
    if (opt?.peerId !== undefined) return this.wireOut(msg, opt.peerId, opt)

    if (msg.to === this.napp.id) {
      this.napp.bus.emit(outboundEvent(msg), { toPeerId: undefined, msg })
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'self-addressed' })
      return false
    }

    // Forwarded (Gateway relay): no backlog entry, no ack tracking — its sender holds it for replay.
    if (opt?.forwarded) {
      const toPeerId = this.peerAppTable.getPeerIdbyAppId(msg.to) ?? this.peerAppTable.getGatewayPeerId()
      return this.wireOut(msg, toPeerId, opt)
    }

    const reachable = this.resolveRoute(msg.to)
    if (reachable === 'unknown') {
      this.napp.bus.emit(outboundEvent(msg), { toPeerId: undefined, msg })
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'no-route' })
      return false
    }

    // A retransmit is already in the backlog — re-admitting would double-count bytes and reset its position.
    if (!opt?.retransmit) {
      const rec: OutboundRecord = { msg, destAppId: msg.to, bytes: measureBytes(msg), sentOnce: false }
      for (const ev of this.backlogTable.add(rec)) {
        this.napp.bus.emit(NACPInternal.backlogWarning, { msg: ev.rec.msg, reason: ev.reason })
        this.settleDeparture(ev.rec.msg.id, false)
      }
      if (!this.backlogTable.has(msg.id)) return false    // refused by a cap (only ever a notify)
    }

    if (reachable === 'offline') return true
    return this.popOne(msg.id)
  }

  /** `unknown` = not known AND no Gateway fallback to ask. */
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
      if (r.msg.id !== msgId) this.backlogTable.add(r)
    })

    if (!expectsAck(rec.msg.type)) {
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

  /** Last step before NACT: announce on `nacp:outbound:{type}`, then hand over. */
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

  /** Send and await DEPARTURE (for types that get no ack). */
  private send(msg: NACPMessage): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.departureWaiters.set(msg.id, resolve)
      if (!this.outbound(msg)) this.settleDeparture(msg.id, false)
    })
  }

  /** Send and await the ACK. Resolves false when given up on (cap eviction / App forgotten). */
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

  /** Start the ack clock for one App, if not already running. */
  private armAckTimer(appId: string) {
    if (this.ackTimers.has(appId)) return
    const t = setTimeout(() => {
      this.ackTimers.delete(appId)
      const oldest = this.ackPendingTable.listByAppId(appId)[0]
      if (!oldest) return
      this.napp.bus.emit(NACPInternal.ackWarning, { msg: oldest.msg, reason: 'timeout' })
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
   * Send a request and await its ONE terminal response. For event kinds, AutoSub builds the LOCAL half
   * before the request goes out (subId = reqId); the remote half is `onSubscribe(autoSub:true)` at request
   * arrival. open: request()/onRequest() → onSubscribe; close: onResponse()/response out → onUnsubscribe.
   */
  request(
    to: string,
    opt: {
      kind: RequestKind; target?: string; payload?: any
      onProcess?: (chunk: any, msg: NotifyMessage) => void; onProcessEnd?: () => void
    },
  ): { reqId: string; response: Promise<ResponseMessage> } {
    const msg = this.build('request', to, { kind: opt.kind, target: opt.target, payload: opt.payload }) as RequestMessage
    // event ONLY: ability produces no process stream. Gated on kind ALONE (all the responder can see).
    if (opt.kind === 'event') {
      this.subscribe(to, callProcessName(opt.kind, msg.id), opt.onProcess, {
        subId: msg.id, autoSub: true, onEnd: opt.onProcessEnd,
      })
    }
    return { reqId: msg.id, response: this.Send4Response(msg, to) }
  }

  /** One-way process chunk; the only type with no ack (cheapest to drop on overflow). Resolves on DEPARTURE. */
  notify(to: string, opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any }): Promise<boolean> {
    return this.send(this.build('notify', to, opt))
  }

  /** Acknowledge receipt of one message. ACK itself expects no ACK. */
  ack(to: string, opt: { parentId: string }): Promise<boolean> {
    return this.send(this.build('ack', to, opt))
  }

  /** Send a control message to an active Event request; ACK names the Signal's own id. */
  signal(to: string, opt: SignalOpt): Promise<boolean> {
    return this.send4Ack(this.build('signal', to, {
      parentId: opt.parentId,
      signalKind: opt.kind,
      ...(opt.kind === 'normal' && { payload: opt.payload }),
    }))
  }

  /**
   * Send a response; resolves once it has been ACKNOWLEDGED.
   *
   * For event kinds, sending the response IS the virtual unsubscribe's outbound half: the local
   * SubscribeTable record is torn down here either way (synchronously), even if the packet cannot leave.
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
   * The DIALLING side of the register handshake — bind, await, verify identity, settle the Gateway slot,
   * announce online. Returns whether the App is now registered; the reason lives on
   * `nacp:internal:register:error`.
   */
  async register(to: string, peer: Peer): Promise<boolean> {
    // Bind eagerly: the handshake response routes by appId.
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
      // Pass the peer's whyNotOk through so both ends report the identical cause.
      if (!(e instanceof NACPError)) return fail('register-failed')
      if (e.code === 'response-not-ok') return fail(e.message)
      return fail(e.code === 'timeout' ? 'response-timeout' : e.code)
    }
    if (res.from !== to) return fail('expect-mismatch')

    const reg = res.payload as RegisterResponsePayload | undefined
    const gatewayVerdict = this.settleGatewayByDeclared(to, peer.id, reg?.isGateway === true)
    if (gatewayVerdict === 'conflict') {
      // Say goodbye first so the peer drops our appId instead of waiting for a heartbeat.
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
   * Subscribe on a peer's bus. The ListenTable record is built UNCONDITIONALLY: omitting targetListener
   * means `() => {}`, not "no subscription".
   *
   *   subId   — override the ListenTable key; must equal whatever the SUBSCRIBED side stamps into notify
   *             parentId. Explicit subscribe: this message's id (default). AutoSub: the reqId.
   *   autoSub — build the local half only; remote half is `onSubscribe(autoSub:true)` at request arrival.
   */
  subscribe(
    to: string,
    targetSubName: string,
    targetListener: (payload: any, msg: NotifyMessage) => void = () => {},
    opt: { subId?: string; autoSub?: boolean; onEnd?: () => void; onSubId?: (subId: string) => void } = {},
  ): Promise<ResponseMessage> | void {
    const msg = this.build('subscribe', to, { targetSubName }) as SubscribeMessage
    const subId = opt.subId ?? msg.id
    this.listenTable.add({ subId, appId: to, targetSubName, targetListener, onEnd: opt.onEnd })
    // Synchronous, before the round trip: a stream wrapper needs subId for its cancel path.
    opt.onSubId?.(subId)
    if (opt.autoSub) return
    return this.Send4Response(msg, to).catch((e) => { this.listenTable.deleteListenRecordbySubId(subId); throw e })
  }

  /** Cancel a subscription on a peer (a remote `off`); also drops the local ListenTable record. */
  unsubscribe(to: string, targetSubId: string, opt: { autoSub?: boolean } = {}): Promise<ResponseMessage> | void {
    const msg = this.build('unsubscribe', to, { targetSubId }) as UnsubscribeMessage
    this.listenTable.deleteListenRecordbySubId(targetSubId)
    if (opt.autoSub) return
    return this.Send4Response(msg, to)
  }

  /** Await the ONE terminal response for a message (timeout + settle wrapped in one promise). */
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
      // A packet that never left cannot be answered — fail now instead of hanging (request has no timeout).
      if (!this.outbound(msg)) {
        this.pendingTable.settle(msg.id)
        reject(nacpOutbound('not-sent', `${msg.type} ${msg.id} to '${msg.to}' was never sent — see nacp:internal:route:error`))
      }
    })
  }

  /** Bridge from a local bus hit to an outbound notify, shared by explicit subscribe and AutoSub. */
  private registerForwardingListener(parentId: string, subscriber: string, targetSubName: string): string {
    return this.napp.bus.listen(targetSubName, (payload: any, hitSubName: string) => {
      // Fire-and-forget: must not hold up the emit that produced it.
      void this.notify(subscriber, { parentId, targetSubName, hitSubName, payload })
    })
  }

  // ── the App link lifecycle: online → offline → gone ──

  /**
   * An App became unreachable (socket drop or ack timeout). Nothing is torn down:
   * mark offline + snapshot, unshift unacked messages to the FRONT of the backlog (preserves original
   * order), start the grace clock. Subscriptions keep running across the blip.
   */
  private markOffline(appId: string) {
    if (!this.peerAppTable.markOffline(appId)) return    // unknown or already offline — first snapshot wins
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
    if (!this.pendingTable.hasFor(appId)) t.unref?.()
    this.graceTimers.set(appId, t)
  }

  /** An App came back: cancel the grace clock and drain its backlog in insertion order. */
  private resumeApp(appId: string) {
    const t = this.graceTimers.get(appId)
    if (t) { clearTimeout(t); this.graceTimers.delete(appId) }
    for (const rec of this.backlogTable.listByAppId(appId)) this.popOne(rec.msg.id)
  }

  /**
   * The App is gone for good (grace expired / said goodbye): discard everything held for it, fail every
   * waiter. Physical connection handling needs the disconnect snapshot (several appIds share a Gateway's
   * peerId):
   *   held the Gateway slot     → close the peer
   *   reached THROUGH a Gateway → leave the socket alone
   *   direct link               → close it
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

    // Give up on everything still queued; tell each waiter.
    for (const rec of this.backlogTable.deleteByAppId(appId)) {
      this.settleDeparture(rec.msg.id, false)
      this.settleAck(rec.msg.id, false)
    }
    for (const rec of this.ackPendingTable.deleteByAppId(appId)) this.settleAck(rec.msg.id, false)
    this.inboundReceivedTable.deleteByAppId(appId)

    this._cleanupPeer(appId)
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId, reason: 'dropped' })

    // NACT last: the disconnect event it fires finds no link record left to act on.
    if (peerId && !viaGateway) void this.napp.nact.closePeer(peerId)
    void reason
  }

  /** Drop the NACP-layer state one App owns (shared by `forget` and `terminate`). */
  private _cleanupPeer(appId: string) {
    this.peerAppTable.deleteAppIdbyAppId(appId)
    this.pendingTable.failFor(appId, `peer '${appId}' is gone`)
    // Both halves of every subscription touching that peer go, one table per direction.
    for (const rec of this.subscribeTable.deleteSubRecordbyAppId(appId)) if (rec.listenId) this.napp.bus.off(rec.listenId)
    this.listenTable.deleteListenRecordbyAppId(appId)
  }

  /** Physical disconnect → mark EVERY appId on that peer offline (Gateway relay shares one peerId). */
  private onPeerDisconnect(peerId: NACTPeerId) {
    for (const appId of this.peerAppTable.listAppIdbyPeerId(peerId)) this.markOffline(appId)
  }

  // ── inbound ──

  inbound(msg: NACPMessage, peer: Peer) {
    // Fired unconditionally, before any processing — including to≠self: the packet HAS logically entered
    // this NApp; whether to drop or forward it is decided below.
    this.napp.bus.emit(inboundEvent(msg), { fromPeerId: peer.id, msg })

    if (msg.to !== this.napp.id) {
      // register never participates in forwarding: a Gateway must not relay a misaddressed register — the
      // sender simply times out (10s), which is how "you dialled the wrong App" surfaces.
      if (msg.type === 'register') {
        this.napp.bus.emit(NACPInternal.gatewayError, { msg, reason: 'dropped' })
        return
      }
      if (this.napp.isGateway && this.checkAppId(msg.to)) this.outbound(msg, { forwarded: true })
      else this.napp.bus.emit(NACPInternal.gatewayError, { msg, reason: 'dropped' })
      return
    }

    // An ack answers nothing and is answered by nothing — handled before the ack-and-dedup layers so it
    // cannot enter them (acking an ack would be an infinite regress).
    if (msg.type === 'ack') return this.onAck(msg)

    // Layer 1 — the protocol-level receipt, sent BEFORE any handling. It says "this arrived", a fact about
    // the wire. Sending it before the dedup check is what makes a replay harmless — the copy is acknowledged
    // again but handled only once.
    //
    // register is the exception, and only because of ordering: there is no appId binding yet, so an ack here
    // would have no route. `onRegister` sends it down the inbound peer once the handshake passes.
    if (msg.type !== 'register') void this.ack(msg.from, { parentId: msg.id })

    // Layer 2 — a replay of something already handled: our earlier ack was lost, or the link dropped before
    // the sender saw it. Stopping here keeps handling exactly-once.
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
   * An inbound ack: let go of the message it names. No consumer = duplicate or already-given-up ack —
   * reported and dropped, never answered (an ack-of-ack chain has no terminal).
   */
  private onAck(msg: AckMessage) {
    const rec = this.ackPendingTable.settle(msg.meta.parentId)
    if (!rec) return void this.napp.bus.emit(NACPInternal.ackError, { msg, reason: 'has-no-consumer' })
    this.settleAck(rec.msg.id, true)
    this.rearmAckTimer(rec.destAppId)
  }

  private onRegister(msg: RegisterMessage, peer: Peer) {
    const from = msg.from
    const peerId = peer.id
    const reject = (reason: string) => {
      this.napp.bus.emit(NACPInternal.registerError, { fromPeerId: peerId, from, reason })
      // No appId binding yet — answer straight down the inbound peerId.
      this.outbound(this.build('response', from, { parentId: msg.id, isOk: false, whyNotOk: reason }), { peerId })
      // Defence against a peer that ignores whyNotOk and will not leave.
      setTimeout(() => { try { peer.close() } catch { /* already gone */ } }, RESPONSE_TIMEOUT_MS).unref()
    }

    const reg = msg.payload as RegisterPayload | undefined
    if (reg?.isGateway && this.napp.isGateway) return reject('dual-gateway')
    if (msg.v.major !== PROTOCOL_V.major) return reject('version-mismatch')
    // Reject the NEW one, keep the old: evicting would let two same-appId processes kick each other in a
    // loop. An OFFLINE appId must NOT be refused — this register IS the reconnect the grace window held open.
    if (this.peerAppTable.isOnline(from)) return reject('appId-in-use')
    const returning = this.peerAppTable.getState(from) === 'offline'

    this.bindAppId(from, peerId)
    const gatewayVerdict = this.settleGatewayByDeclared(from, peerId, reg?.isGateway === true)
    if (gatewayVerdict === 'conflict') {
      this.dropAppId(from)
      return reject('multi-gateway')
    }
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId: from, reason: 'bound', isGateway: gatewayVerdict === 'adopted' })
    // The binding now exists, so the ordinary public ACK path can route the handshake ACK.
    void this.ack(from, { parentId: msg.id })
    // Symmetric exchange: our decl + isGateway in the same round trip.
    void this.response(from, { parentId: msg.id, isOk: true,
      payload: { isGateway: this.napp.isGateway, decl: this.napp.buildDecl() } satisfies RegisterResponsePayload })
    // Last: the handshake answer must precede the backlog it unblocks.
    if (returning) this.resumeApp(from)
  }

  /**
   * A peer is leaving on purpose: no grace window, everything queued for it goes. The answer goes out BEFORE
   * cleanup (the route must still exist), and is not awaited — the peer is already tearing itself down.
   */
  private onUnregister(msg: UnregisterMessage) {
    void this.response(msg.from, { parentId: msg.id, isOk: true })
    this.forget(msg.from, 'unregistered')
  }

  /** A response arrived: settle its waiter. For event kinds, arrival IS the virtual unsubscribe's inbound half. */
  private onResponse(msg: ResponseMessage) {
    if (msg.meta.kind === 'event') this.unsubscribe(msg.from, msg.meta.parentId, { autoSub: true })
    const e = this.pendingTable.settle(msg.meta.parentId)
    if (!e) return void this.napp.bus.emit(NACPInternal.responseError, { msg, reason: 'has-no-consumer' })
    if (msg.meta.isOk) e.resolve(msg)
    else e.reject(nacpInbound('response-not-ok', msg.meta.whyNotOk ?? 'response isOk=false'))
  }

  /**
   * A request arrived: find the Processor for that kind, push the request in, turn its two callbacks into
   * bus events. For event kinds, AutoSub's remote half runs here via `onSubscribe(autoSub:true)` with a
   * simulated subscribe message (`id=reqId`), so SubscribeTable records are identical in shape.
   */
  private onRequest(msg: RequestMessage) {
    const kind = msg.meta.kind

    const proc: Processor | undefined = this.napp.getProcessor(kind)
    if (!proc) {
      this.napp.bus.emit(NACPInternal.requestError, { msg, reason: 'no-processor' })
      void this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: `no-processor for kind '${kind}'`, kind })
      return
    }

    const reqId = msg.id
    // event ONLY: register the forwarding listener before pushing, so a synchronous Processor isn't missed.
    if (kind === 'event') {
      this.onSubscribe({ id: reqId, from: msg.from, payload: { targetSubName: callProcessName(kind, reqId) } } as SubscribeMessage, { autoSub: true })
    }

    proc.push(
      { target: msg.meta.target ?? '', payload: msg.payload, reqId },
      {
        onProcess: (chunk) => { this.napp.bus.emit(callProcessName(kind, reqId), chunk) },
        onResponse: (result, isOk, whyNotOk) => {
          this.napp.bus.emit(callResponseName(kind, reqId), { result, isOk, whyNotOk })
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

  /** An inbound notify → ListenTable lookup by parentId → targetListener. A notify never settles the
   *  pending entry: it is a push, not the terminal. */
  private onNotify(msg: NotifyMessage) {
    const parentId = msg.meta.parentId

    const rec = this.listenTable.getListenRecordbySubId(parentId)
    if (rec) return rec.targetListener(msg.payload, msg)

    this.napp.bus.emit(NACPInternal.notifyError, { msg, reason: 'has-no-consumer' })
  }

  /** subscribe == a remote listen: register the name on our own bus, pack every hit into a notify.
   *  With autoSub, no subscribeResponse goes back — AutoSub is answered by the request's own response. */
  private onSubscribe(msg: SubscribeMessage, { autoSub = false }: { autoSub?: boolean } = {}) {
    const subId = msg.id
    const subscriber = msg.from
    const targetSubName = (msg.payload as SubscribePayload)?.targetSubName

    // In-band reject: a missing targetSubName would throw inside bus.listen and propagate into NACT's peer
    // path, which treats any throw as a framing fault and tears down the whole connection.
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
    if (!autoSub)
      void this.response(subscriber, {
        parentId: subId, isOk: true, payload: { targetSubId: subId } satisfies SubscribeResponsePayload,
      })
  }

  /** unsubscribe == a remote off. With autoSub, a missing record stays silent (the peer may have taken it
   *  away first via _cleanupPeer). */
  private onUnsubscribe(msg: UnsubscribeMessage, { autoSub = false }: { autoSub?: boolean } = {}) {
    const rec = this.subscribeTable.deleteSubRecordbySubId((msg.payload as UnsubscribePayload).targetSubId)
    if (!rec) {
      if (autoSub) return
      this.napp.bus.emit(NACPInternal.subscribeError, { msg, reason: 'unknown-subscription' })
      void this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: 'unknown-subscription' })
      return
    }
    if (rec.listenId) this.napp.bus.off(rec.listenId)
    if (!autoSub) void this.response(msg.from, { parentId: msg.id, isOk: true })
  }

  /** Tear down everything this layer holds: fail every waiter, off every listener, clear every table. */
  terminate() {
    this.pendingTable.failAll('nacp terminate')
    for (const rec of this.subscribeTable.listSubRecord()) if (rec.listenId) this.napp.bus.off(rec.listenId)
    this.subscribeTable.clear()
    this.listenTable.clear()
    this.peerAppTable.clear()
    // Every clock, then every queue; each abandoned message tells its waiter.
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
