/**
 * NApp — NASDK's facade: the concrete thing a user instantiates, and where ALL configuration enters.
 * NApp / NACP / NACT are three PARALLEL members of NASDK; NApp is not a category containing the other two.
 * At runtime it does assemble them: `new NApp` builds both and hands each a
 * hand-cut ref box (see NApp/types.ts), so each reaches exactly the capabilities it needs and nothing
 * more: NACP gets NACT's `sendToPeer`, NACT gets NACP's `inbound`, neither gets the other
 * whole. One shared EventBus instance, owned here, carries every nacp:* and nact:* event.
 *
 * NApp is an assembly and a doorway, NOT a message processor: its outbound methods forward to NACP, which
 * builds, pairs, dispatches, and resolves peerIds from its own tables. NApp holds only the Processor binding
 * table (NACP reads it through the ref box) and the transport entries to expose.
 *
 * It does not distinguish Client from Server: `server[]` entries are what you EXPOSE, `connect()` is what
 * you DIAL, and one App routinely does both. TransportSpec describes "which carrier + address" for either
 * direction — direction is decided by where a spec is used.
 */

import { EventBus } from '../EventBus.ts'
import type { Processor } from '../types.ts'
import { NACP } from '../NACP/NACP.ts'
import { NACT } from '../NACT/NACT.ts'
import { NACTEvent } from '../NACT/events.ts'
import type { ServerHandle, TransportSpec } from '../NACT/types.ts'
import type {
  Declaration, NotifyMessage, RequestKind, ResponseMessage,
} from '../NACP/types.ts'
import { NACPInternal } from '../NACP/events.ts'
import type { NACPPrivateRef, NACTPrivateRef, NAppOpts } from './types.ts'
import { nappInbound, nappInternal, nappOutbound } from './errors.ts'

export class NApp {
  readonly id: string
  readonly isGateway: boolean
  /** The shared communication-stack bus. Everything observable about this App flows here. */
  readonly bus = new EventBus()
  readonly nacp: NACP
  readonly nact: NACT

  private explicitDecl?: Declaration
  private processors = new Map<RequestKind, Processor>()   // NApp owns; NACP reads via its ref box
  private serverSpecs: TransportSpec[]
  private handles: ServerHandle[] = []
  /** Irreversible once set. Locks the outbound API — except the unregister frames stop() itself sends, and
   *  their responses, which must still flow for a graceful goodbye. */
  private stopping = false

  constructor(o: NAppOpts) {
    if (!o.id) throw nappInternal('no-id', 'NApp: id required')
    this.id = o.id
    this.explicitDecl = o.decl
    this.serverSpecs = o.server ?? []
    this.isGateway = o.opt?.isGateway ?? false

    // Both ref boxes are built BEFORE the children, and their sibling entries are thin lambdas that read
    // `this.nacp` / `this.nact` at CALL time. That is what breaks the construction cycle (the same trick
    // NACEB uses with lazy getters in NACEBPrivateRef) without either child ever holding the other.
    const nacpRef: NACPPrivateRef = {
      selfId: this.id,
      isGateway: this.isGateway,
      emit: (name, payload, thisArg) => this.bus.emit(name, payload, thisArg),
      listen: (name, cb) => this.bus.listen(name, cb),
      off: (listenId) => this.bus.off(listenId),
      buildDecl: () => this.buildDecl(),
      dispatch: (kind) => this.processors.get(kind as RequestKind),
      sendToPeer: (peerId, msg) => this.nact.sendToPeer(peerId, msg),
    }
    const nactRef: NACTPrivateRef = {
      emit: (name, payload) => this.bus.emit(name, payload),
      inbound: (msg, peer) => this.nacp.inbound(msg, peer),
    }

    this.nacp = new NACP(nacpRef)
    this.nact = new NACT(nactRef)

    // Physical disconnect → NACP-layer offline cleanup (drop the appId, fail its waiters, off its listeners).
    this.bus.listen(NACTEvent.peerDisconnect, ({ peerId }: { peerId: string }) => {
      this.nacp.onPeerDisconnect(peerId)
    })
  }

  // ── declaration ──

  /** This App's declaration. An explicit one wins; otherwise it is aggregated from the bound processors —
   *  "no abilities" is simply an empty list, needing no marker. */
  buildDecl(): Declaration {
    if (this.explicitDecl) return this.explicitDecl
    const events = this.processors.get('event')?.list() ?? []
    const abilities = this.processors.get('ability')?.list() ?? []
    return { events, abilities }
  }

  /** Bind the Processor for a kind. NACP only ever sees the `Processor` contract — it does not import or
   *  know NACEB/NACAB, so anything satisfying list+push can be bound here. */
  bindProcessor(kind: RequestKind, processor: Processor) { this.processors.set(kind, processor) }

  // ── lifecycle ──

  /** Bring up every declared server entry. Nothing was listening before this. */
  async start() {
    for (const spec of this.serverSpecs) this.handles.push(await this.nact.listen(spec))
  }

  /**
   * Graceful shutdown, in the order the protocol requires:
   *   1. latch `stopping` (irreversible) so no new outbound work starts
   *   2. send unregister to every connected App and await their acknowledgements (or time out)
   *   3. fail every remaining waiter, off every listener, clear all three tables
   *   4. close every peer
   *   5. close every server entry
   * Steps 2 and 3 are ordered this way so the goodbye goes out while routes still exist.
   */
  async stop() {
    if (this.stopping) return
    this.stopping = true
    await Promise.allSettled(this.nacp.appIds().map(appId => this.nacp.unregister(appId)))
    this.nacp.shutdown()
    await this.nact.close()
    await Promise.all(this.handles.map(h => h.close()))
    this.handles = []
  }

  /**
   * Dial a peer and complete the register handshake. `expect` is mandatory — the dialler must know who it
   * means to reach, and that name goes straight into register's `to`. The peer answers only if that name is
   * its own; a mismatch is silently dropped and surfaces here as the 10s timeout.
   *
   * `asGateway`: mark this peer as the outbound fallback for this App. Only ONE peer may be the Gateway
   * at a time — calling connect with asGateway:true on a second peer silently replaces the first.
   * This is a LOCAL routing decision; the remote peer is not notified that it was chosen as a Gateway.
   * The remote's own `isGateway` flag (in its register accept) is purely informational — it signals
   * "I am willing to forward", but whether THIS App uses it as its fallback is decided here by the caller.
   */
  async connect(expect: string, target: TransportSpec, opt?: { asGateway?: boolean }): Promise<void> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')

    const peer = await this.nact.dial(target)
    // Bind eagerly: the handshake response (and everything after) routes by appId, so without this the
    // accept could not find its way back out. Rolled back below if the handshake fails.
    this.nacp.bindAppId(expect, peer.id)
    try {
      const res = await this.nacp.register(expect)
      if (res.from !== expect)
        throw nappInbound('expect-mismatch', `connected to '${res.from}', expected '${expect}'`)
      // Re-bind with asGateway if the caller requested it. The remote's isGateway is informational only.
      if (opt?.asGateway) this.nacp.bindAppId(expect, peer.id, true)
      // Symmetric with the server side (which emits this in onRegister): logical online, not physical connect.
      this.bus.emit(NACPInternal.nappOnline, { appId: expect, isGateway: res.meta.isGateway === true })
    } catch (e) {
      this.nacp.dropAppId(expect)
      try { peer.close() } catch { /* already gone */ }
      throw e
    }
  }

  // ── outbound API (all forward to NACP; register/unregister are driven by connect/stop) ──

  /** Send a request and await its ONE terminal response. `onProcess` receives the process stream flowing
   *  back from this call's auto-subscription (event kinds; abilities never produce one).
   *  Fire-and-forget is simply not awaiting the promise — there is deliberately no `fire` method. */
  request(
    to: string,
    opt: { kind: RequestKind; target?: string; payload?: any; onProcess?: (chunk: any) => void },
  ): Promise<ResponseMessage> {
    if (this.stopping) return Promise.reject(nappOutbound('stopping', 'NApp is stopping'))
    return this.nacp.request(to, opt)
  }

  /** Subscribe to an event name on a peer's bus. Resolves once the peer confirms; `subId` (needed to
   *  unsubscribe) is the returned response's `meta.parentId`. */
  async subscribe(
    to: string, targetSubName: string, onNotify?: (payload: any, msg: NotifyMessage) => void,
  ): Promise<{ subId: string; response: ResponseMessage }> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')
    const response = await this.nacp.subscribe(to, targetSubName, onNotify)
    return { subId: response.meta.parentId, response }
  }

  /** Cancel a subscription on a peer (a remote `off`). */
  unsubscribe(to: string, targetSubId: string): Promise<ResponseMessage> {
    if (this.stopping) return Promise.reject(nappOutbound('stopping', 'NApp is stopping'))
    return this.nacp.unsubscribe(to, targetSubId)
  }

  notify(to: string, opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any }): void {
    if (this.stopping) return
    this.nacp.notify(to, opt)
  }

  response(
    to: string,
    opt: { parentId: string; isOk: boolean; whyNotOk?: string; kind?: RequestKind; decl?: Declaration; payload?: any },
  ): void {
    if (this.stopping) return
    this.nacp.response(to, opt)
  }

  // ── observation (the raw bus is equally valid: this.bus.listen(...) directly) ──

  on(name: string, cb: (p: any) => void): string { return this.bus.listen(name, cb) }
  once(name: string, cb: (p: any) => void): string { return this.bus.listenOnce(name, cb) }
  off(listenId: string): boolean { return this.bus.off(listenId) }

  connectedApps(): string[] { return this.nacp.appIds() }
}
