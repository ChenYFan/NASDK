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

const RESPONSE_TIMEOUT_MS = 10000
const REQUEST_TIMEOUT_MS  = -1             // business call, no timeout

function expectsAck(type: NACPType): boolean { return type !== 'notify' && type !== 'ack' }

export class NACP {
  private peerAppTable = new PeerAppConnectionTable()
  private pendingTable = new ResponsePendingTable()
  private subscribeTable = new SubscribeTable()
  private listenTable = new ListenTable()
  private backlogTable: OutboundBacklogTable
  private ackPendingTable: AckPendingTable
  private inboundReceivedTable: InboundReceivedTable
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private departureWaiters = new Map<string, (sent: boolean) => void>()
  private departing = new Map<string, { rec: OutboundRecord }>()
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

  bindAppId(appId: string, peerId: NACTPeerId) { this.peerAppTable.bind(appId, peerId) }
  checkAppId(appId: string): boolean { return this.peerAppTable.has(appId) }
  dropAppId(appId: string) { this.peerAppTable.deleteAppIdbyAppId(appId) }
  listAppId(): string[] { return this.peerAppTable.listAppId() }
  listOnlineAppId(): string[] { return this.peerAppTable.listOnlineAppId() }
  getAppPeerId(appId: string): NACTPeerId | undefined { return this.peerAppTable.getPeerIdbyAppId(appId) }
  getGatewayPeerId(): NACTPeerId | undefined { return this.peerAppTable.getGatewayPeerId() }

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

  getSubCount(): number { return this.subscribeTable.size() }
  getListenCount(): number { return this.listenTable.size() }
  getPendingCount(): number { return this.pendingTable.size() }

  private build(type: NACPType, to: string, opt: BuildOpt = {}): NACPMessage {
    if (type === 'register') opt = { ...opt, isGateway: this.napp.isGateway, decl: this.napp.buildDecl() }
    return buildMessage(this.napp.id, type, to, opt)
  }

  outbound(msg: NACPMessage, opt?: { peerId?: NACTPeerId; forwarded?: boolean; retransmit?: boolean }): boolean {
    // Explicit peerId bypasses both stages — no binding exists yet on register rejection.
    if (opt?.peerId !== undefined) return this.wireOut(msg, opt.peerId, opt)

    if (msg.to === this.napp.id) {
      this.napp.bus.emit(outboundEvent(msg), { toPeerId: undefined, msg })
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'self-addressed' })
      return false
    }

    // Forwarded (Gateway relay): the sender's side holds it for replay, so no backlog / ack tracking here.
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

    // Re-admitting a retransmit would double-count bytes and reset its queue position.
    if (!opt?.retransmit) {
      const rec: OutboundRecord = { msg, destAppId: msg.to, bytes: measureBytes(msg), sentOnce: false }
      for (const ev of this.backlogTable.add(rec)) {
        this.napp.bus.emit(NACPInternal.backlogWarning, { msg: ev.rec.msg, reason: ev.reason })
        this.discardOutbound(ev.rec.msg.id)
      }
      if (!this.backlogTable.has(msg.id)) return false    // refused by a cap (only ever a notify)
    }

    if (reachable === 'offline') return true
    return this.popOne(msg.id)
  }

  private resolveRoute(appId: string): 'online' | 'offline' | 'unknown' {
    const state = this.peerAppTable.getState(appId)
    if (state === 'online') return 'online'
    if (state === 'offline') return 'offline'
    return this.peerAppTable.getGatewayPeerId() ? 'online' : 'unknown'
  }

  private popOne(msgId: string): boolean {
    const rec = this.backlogTable.get(msgId)
    if (!rec) return false
    if (this.departing.has(msgId)) return true
    const toPeerId = this.peerAppTable.getPeerIdbyAppId(rec.msg.to) ?? this.peerAppTable.getGatewayPeerId()
    const attempt = { rec }
    this.departing.set(msgId, attempt)
    this.backlogTable.delete(msgId)
    return this.wireOut(rec.msg, toPeerId, {}, (sent) => {
      // Offline, discard, or an early ACK may already have retired this attempt.
      if (this.departing.get(msgId) !== attempt) return
      this.departing.delete(msgId)
      if (!sent) {
        this.discardOutbound(msgId, nacpOutbound('not-sent', `${rec.msg.type} ${msgId} was not accepted by the Provider`))
        return
      }
      this.settleDeparture(msgId, true)
      if (!expectsAck(rec.msg.type)) return
      const evictedApps = new Set<string>()
      for (const ev of this.ackPendingTable.add(rec)) {
        this.napp.bus.emit(NACPInternal.ackWarning, { msg: ev.msg, reason: 'pending-overflow' })
        this.settleAck(ev.msg.id, false)
        evictedApps.add(ev.destAppId)
      }
      // Eviction retires the timer's old head; only retained records may time out.
      for (const appId of evictedApps) this.rearmAckTimer(appId)
      this.armAckTimer(rec.destAppId)
    })
  }

  private wireOut(
    msg: NACPMessage, toPeerId: NACTPeerId | undefined, opt: { forwarded?: boolean },
    onAccepted?: (accepted: boolean) => void,
  ): boolean {
    this.napp.bus.emit(outboundEvent(msg), { toPeerId, msg })
    if (!toPeerId) {
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'no-route' })
      onAccepted?.(false)
      return false
    }
    if (!this.napp.nact.getPeer(toPeerId)) {
      this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'send-failed' })
      onAccepted?.(false)
      return false
    }
    const complete = (accepted: boolean) => {
      if (!accepted) this.napp.bus.emit(NACPInternal.routeError, { msg, reason: 'send-failed' })
      else if (opt.forwarded) this.napp.bus.emit(NACPInternal.gatewaySuccess, { toPeerId, msg, reason: 'forwarded' })
      onAccepted?.(accepted)
    }
    void this.napp.nact.sendToPeer(toPeerId, msg).then(complete, () => complete(false))
    return true
  }

  /** Awaits local Provider acceptance, without waiting for ACK. */
  private send(msg: NACPMessage): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.departureWaiters.set(msg.id, resolve)
      if (!this.outbound(msg)) this.settleDeparture(msg.id, false)
    })
  }

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

  private drainDeparting(appId: string): OutboundRecord[] {
    const records: OutboundRecord[] = []
    for (const [id, attempt] of this.departing) {
      if (attempt.rec.destAppId !== appId) continue
      this.departing.delete(id)
      records.push(attempt.rec)
    }
    return records
  }

  private settleAck(msgId: string, ok: boolean) {
    const w = this.ackWaiters.get(msgId)
    if (!w) return
    this.ackWaiters.delete(msgId)
    w.resolve(ok)
  }

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

  private rearmAckTimer(appId: string) {
    const t = this.ackTimers.get(appId)
    if (t) { clearTimeout(t); this.ackTimers.delete(appId) }
    if (this.ackPendingTable.listByAppId(appId).length > 0) this.armAckTimer(appId)
  }

  // ── outbound helpers ──

  request(
    to: string,
    opt: {
      kind: RequestKind; target?: string; payload?: any
      onProcess?: (chunk: any, msg: NotifyMessage) => void; onProcessEnd?: () => void
      onReqId?: (reqId: string) => void
    },
  ): Promise<ResponseMessage> {
    const msg = this.build('request', to, { kind: opt.kind, target: opt.target, payload: opt.payload }) as RequestMessage
    opt.onReqId?.(msg.id)
    // Gated on kind alone — all the responder can see.
    if (opt.kind === 'event') {
      this.subscribe(to, callProcessName(opt.kind, msg.id), opt.onProcess, {
        subId: msg.id, autoSub: true, onEnd: opt.onProcessEnd,
      })
    }
    return this.Send4Response(msg, to)
  }

  discardOutbound(msgId: string, reason?: Error): void {
    this.departing.delete(msgId)
    this.backlogTable.delete(msgId)
    const unacked = this.ackPendingTable.settle(msgId)
    if (unacked) this.rearmAckTimer(unacked.destAppId)
    this.settleDeparture(msgId, false)
    this.settleAck(msgId, false)
    this.settlePendingResponse(msgId)?.reject(reason ?? nacpOutbound('discarded', `outbound message ${msgId} was discarded`))
  }

  notify(to: string, opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any }): Promise<boolean> {
    return this.send(this.build('notify', to, opt))
  }

  ack(to: string, opt: { parentId: string }): Promise<boolean> {
    return this.send(this.build('ack', to, opt))
  }

  signal(to: string, opt: SignalOpt): Promise<boolean> {
    return this.send4Ack(this.build('signal', to, {
      parentId: opt.parentId,
      signalKind: opt.kind,
      ...(opt.kind === 'normal' && { payload: opt.payload }),
    }))
  }

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

  async register(to: string, peer: Peer): Promise<boolean> {
    const returning = this.peerAppTable.getState(to) === 'offline'   // read before bind resets it
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
      if (!(e instanceof NACPError)) return fail('register-failed')
      if (e.code === 'response-not-ok') return fail(e.message)
      return fail(e.code === 'timeout' ? 'response-timeout' : e.code)
    }
    if (res.from !== to) return fail('expect-mismatch')

    const reg = res.payload as RegisterResponsePayload | undefined
    const gatewayVerdict = this.settleGatewayByDeclared(to, peer.id, reg?.isGateway === true)
    if (gatewayVerdict === 'conflict') {
      void this.unregister(to)?.catch(() => { /* peer is going away anyway */ })
      return fail('multi-gateway')
    }
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId: to, reason: 'bound', isGateway: gatewayVerdict === 'adopted' })
    if (returning) this.resumeApp(to)
    return true
  }

  unregister(to: string): Promise<ResponseMessage> {
    return this.Send4Response(this.build('unregister', to), to)
  }

  subscribe(
    to: string,
    targetSubName: string,
    targetListener: (payload: any, msg: NotifyMessage) => void = () => {},
    opt: { subId?: string; autoSub?: boolean; onEnd?: () => void; onSubId?: (subId: string) => void } = {},
  ): Promise<ResponseMessage> | void {
    const msg = this.build('subscribe', to, { targetSubName }) as SubscribeMessage
    const subId = opt.subId ?? msg.id
    this.listenTable.add({ subId, appId: to, targetSubName, targetListener, onEnd: opt.onEnd })
    // Synchronous, before the round trip: stream wrappers need subId for their cancel path.
    opt.onSubId?.(subId)
    if (opt.autoSub) return
    return this.Send4Response(msg, to).catch((e) => { this.listenTable.deleteListenRecordbySubId(subId); throw e })
  }

  unsubscribe(to: string, targetSubId: string, opt: { autoSub?: boolean } = {}): Promise<ResponseMessage> | void {
    const msg = this.build('unsubscribe', to, { targetSubId }) as UnsubscribeMessage
    this.listenTable.deleteListenRecordbySubId(targetSubId)
    if (opt.autoSub) return
    return this.Send4Response(msg, to)
  }

  private Send4Response(
    msg: NACPMessage, destAppId: string,
  ): Promise<ResponseMessage> {
    const isRequest = msg.type === 'request'
    const timeoutMs = isRequest ? REQUEST_TIMEOUT_MS : RESPONSE_TIMEOUT_MS
    return new Promise<ResponseMessage>((resolve, reject) => {
      const timer = timeoutMs < 0 ? undefined : setTimeout(() => {
        this.settlePendingResponse(msg.id)
        reject(nacpOutbound('timeout', `no response for ${msg.type} ${msg.id} within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingTable.add(msg.id, { resolve, reject, timer: timer as ReturnType<typeof setTimeout>, destAppId })
      this.syncGraceTimerRef(destAppId)
      // A packet that never left cannot be answered — and requests have no timeout.
      if (!this.outbound(msg)) {
        this.settlePendingResponse(msg.id)
        reject(nacpOutbound('not-sent', `${msg.type} ${msg.id} to '${msg.to}' was never sent — see nacp:internal:route:error`))
      }
    })
  }

  private settlePendingResponse(msgId: string) {
    const entry = this.pendingTable.settle(msgId)
    if (entry) this.syncGraceTimerRef(entry.destAppId)
    return entry
  }

  private registerForwardingListener(parentId: string, subscriber: string, targetSubName: string): string {
    return this.napp.bus.listen(targetSubName, (payload: any, hitSubName: string) => {
      // Fire-and-forget: must not hold up the emit that produced it.
      void this.notify(subscriber, { parentId, targetSubName, hitSubName, payload })
    })
  }

  // ── the App link lifecycle: online → offline → gone ──

  markOffline(appId: string) {
    if (!this.peerAppTable.markOffline(appId)) return    // already offline — first snapshot wins
    const t = this.ackTimers.get(appId)
    if (t) { clearTimeout(t); this.ackTimers.delete(appId) }
    this.backlogTable.unshiftAll([
      ...this.ackPendingTable.drainByAppId(appId), ...this.drainDeparting(appId),
    ])
    this.armGraceTimer(appId)
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId, reason: 'offline' })
  }

  private armGraceTimer(appId: string) {
    const existing = this.graceTimers.get(appId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => { this.graceTimers.delete(appId); this.forget(appId, 'grace-expired') }, this.napp.reconnectGraceMs)
    this.graceTimers.set(appId, t)
    this.syncGraceTimerRef(appId)
  }

  private syncGraceTimerRef(appId: string) {
    const timer = this.graceTimers.get(appId)
    if (!timer) return
    if (this.pendingTable.hasFor(appId)) timer.ref?.()
    else timer.unref?.()
  }

  private resumeApp(appId: string) {
    const t = this.graceTimers.get(appId)
    if (t) { clearTimeout(t); this.graceTimers.delete(appId) }
    for (const rec of this.backlogTable.listByAppId(appId)) this.popOne(rec.msg.id)
  }

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
    for (const rec of [...this.backlogTable.deleteByAppId(appId), ...this.drainDeparting(appId)]) {
      this.settleDeparture(rec.msg.id, false)
      this.settleAck(rec.msg.id, false)
    }
    for (const rec of this.ackPendingTable.deleteByAppId(appId)) this.settleAck(rec.msg.id, false)
    this.inboundReceivedTable.deleteByAppId(appId)

    this._cleanupPeer(appId)
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId, reason: 'dropped' })
    if (peerId && !viaGateway) void this.napp.nact.closePeer(peerId)
    void reason
  }

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
    // Fires even for to≠self — dropping or forwarding is decided below.
    this.napp.bus.emit(inboundEvent(msg), { fromPeerId: peer.id, msg })

    if (msg.to !== this.napp.id) {
      // Never relay a misaddressed register; the sender's 10s timeout surfaces the wrong number.
      if (msg.type === 'register') {
        this.napp.bus.emit(NACPInternal.gatewayError, { msg, reason: 'dropped' })
        return
      }
      if (this.napp.isGateway && this.checkAppId(msg.to)) this.outbound(msg, { forwarded: true })
      else this.napp.bus.emit(NACPInternal.gatewayError, { msg, reason: 'dropped' })
      return
    }

    // Ack answers nothing; kept out of the ack/dedup layers to avoid an ack-of-ack regress.
    if (msg.type === 'ack') return this.onAck(msg)

    // Ack BEFORE handling, even on a replay: acked again, handled once. Register defers its ack —
    // no binding exists yet, so the ack would have no route.
    if (msg.type !== 'register' && expectsAck(msg.type)) void this.ack(msg.from, { parentId: msg.id })

    // A replay: our earlier ack was lost. Stop to keep handling exactly-once.
    if (expectsAck(msg.type) && this.inboundReceivedTable.has(msg.id)) return
    if (expectsAck(msg.type)) this.inboundReceivedTable.add(msg.id, msg.from)

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

  private onAck(msg: AckMessage) {
    const id = msg.meta.parentId
    let rec = this.ackPendingTable.settle(id)
    // A Provider can deliver and receive ACK before its acceptance Promise settles.
    if (!rec) {
      const attempt = this.departing.get(id)
      if (attempt && expectsAck(attempt.rec.msg.type)) {
        rec = attempt.rec
        this.departing.delete(id)
        this.settleDeparture(id, true)
      }
    }
    if (!rec) return void this.napp.bus.emit(NACPInternal.ackError, { msg, reason: 'has-no-consumer' })
    this.settleAck(rec.msg.id, true)
    this.rearmAckTimer(rec.destAppId)
  }

  private onRegister(msg: RegisterMessage, peer: Peer) {
    const from = msg.from
    const peerId = peer.id
    const reject = (reason: string) => {
      this.napp.bus.emit(NACPInternal.registerError, { fromPeerId: peerId, from, reason })
      this.outbound(this.build('response', from, { parentId: msg.id, isOk: false, whyNotOk: reason }), { peerId })
      setTimeout(() => { try { peer.close() } catch { /* already gone */ } }, RESPONSE_TIMEOUT_MS).unref?.()
    }

    const reg = msg.payload as RegisterPayload | undefined
    if (reg?.isGateway && this.napp.isGateway) return reject('dual-gateway')
    if (msg.v.major !== PROTOCOL_V.major) return reject('version-mismatch')
    // Reject the NEW one: evicting would let two same-appId processes kick each other in a loop.
    // An OFFLINE appId must NOT be refused — this register IS the awaited reconnect.
    if (this.peerAppTable.isOnline(from)) return reject('appId-in-use')
    const returning = this.peerAppTable.getState(from) === 'offline'

    this.bindAppId(from, peerId)
    const gatewayVerdict = this.settleGatewayByDeclared(from, peerId, reg?.isGateway === true)
    if (gatewayVerdict === 'conflict') {
      this.dropAppId(from)
      return reject('multi-gateway')
    }
    this.napp.bus.emit(NACPInternal.nappSuccess, { appId: from, reason: 'bound', isGateway: gatewayVerdict === 'adopted' })
    // The binding now exists, so the ordinary ACK path can route the handshake ACK.
    void this.ack(from, { parentId: msg.id })
    void this.response(from, { parentId: msg.id, isOk: true,
      payload: { isGateway: this.napp.isGateway, decl: this.napp.buildDecl() } satisfies RegisterResponsePayload })
    // The handshake answer must precede the backlog it unblocks.
    if (returning) this.resumeApp(from)
  }

  private onUnregister(msg: UnregisterMessage) {
    const peerId = this.getAppPeerId(msg.from)
    const response = this.build('response', msg.from, { parentId: msg.id, isOk: true })
    void this.send(response).then(() => {
      if (this.getAppPeerId(msg.from) === peerId) this.forget(msg.from, 'unregistered')
    })
  }

  private onResponse(msg: ResponseMessage) {
    if (msg.meta.kind === 'event') this.unsubscribe(msg.from, msg.meta.parentId, { autoSub: true })
    const e = this.settlePendingResponse(msg.meta.parentId)
    if (!e) return void this.napp.bus.emit(NACPInternal.responseError, { msg, reason: 'has-no-consumer' })
    if (msg.meta.isOk) e.resolve(msg)
    else e.reject(nacpInbound('response-not-ok', msg.meta.whyNotOk ?? 'response isOk=false'))
  }

  private onRequest(msg: RequestMessage) {
    const kind = msg.meta.kind

    const proc: Processor | undefined = this.napp.getProcessor(kind)
    if (!proc) {
      this.napp.bus.emit(NACPInternal.requestError, { msg, reason: 'no-processor' })
      void this.response(msg.from, { parentId: msg.id, isOk: false, whyNotOk: `no-processor for kind '${kind}'`, kind })
      return
    }

    const reqId = msg.id
    // Register the forwarding listener before pushing, so a synchronous Processor isn't missed.
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

  private onNotify(msg: NotifyMessage) {
    const parentId = msg.meta.parentId

    const rec = this.listenTable.getListenRecordbySubId(parentId)
    if (rec) return rec.targetListener(msg.payload, msg)

    this.napp.bus.emit(NACPInternal.notifyError, { msg, reason: 'has-no-consumer' })
  }

  private onSubscribe(msg: SubscribeMessage, { autoSub = false }: { autoSub?: boolean } = {}) {
    const subId = msg.id
    const subscriber = msg.from
    const targetSubName = (msg.payload as SubscribePayload)?.targetSubName

    // A missing targetSubName would throw inside bus.listen; NACT reads any throw as a framing fault
    // and tears down the connection — reject in-band instead.
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

  terminate() {
    this.departing.clear()
    this.pendingTable.failAll('nacp terminate')
    for (const rec of this.subscribeTable.listSubRecord()) if (rec.listenId) this.napp.bus.off(rec.listenId)
    this.subscribeTable.clear()
    this.listenTable.clear()
    this.peerAppTable.clear()
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
