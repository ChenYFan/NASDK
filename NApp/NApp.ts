/**
 * NApp — NASDK's facade: the concrete thing a user instantiates, and where ALL configuration enters.
 * NApp / NACP / NACT are three PARALLEL members of NASDK; NApp is not a category containing the other two.
 * At runtime it does assemble them: `new NApp` builds both and hands each the SAME one thing — `this`, NApp's
 * public face. Neither gets a private-capability box, and neither gets the other whole: NACP reaches NACT's
 * `sendToPeer`, NACT reaches NACP's `inbound`, both spelled out at the call site.
 * One shared EventBus instance, owned here, carries every nacp:* and nact:* event.
 *
 * NApp is an assembly and a doorway, NOT a message processor: its outbound methods forward to NACP, which
 * builds, pairs, dispatches, and resolves peerIds from its own tables. NApp holds only the Processor binding
 * table (NACP reads it through the public `getProcessor`) and the transport entries to expose.
 *
 * It does not distinguish Client from Server: `server[]` entries are what you EXPOSE, `connect()` is what
 * you DIAL, and one App routinely does both. TransportSpec describes "which carrier + address" for either
 * direction — direction is decided by where a spec is used.
 */

import { EventBus } from '../EventBus.ts'
import type { AbilityProcessor, Processor } from '../types.ts'
import { NACP } from '../NACP/NACP.ts'
import { NACT } from '../NACT/NACT.ts'
// Concrete Processors, imported as VALUES: NApp assembles them as the stock carriers when a kind is left
// unbound. Legitimate for the assembly layer — NACP is the one that must only ever see the contract.
import { NACEB } from '../NACEB/NACEB.ts'
import { NACAB } from '../NACAB/NACAB.ts'
import type { ServerHandle, TransportSpec } from '../NACT/types.ts'
import type {
  Declaration, NotifyMessage, RequestKind, ResponseMessage,
} from '../NACP/types.ts'
import type { NAppOpts } from './types.ts'
import { appAbilities } from './abilities.ts'
import { nappInternal, nappOutbound } from './errors.ts'
import { NAppInternal } from './events.ts'
import { NotifyStream } from './notifyStream.ts'

export class NApp {
  readonly id: string
  readonly isGateway: boolean
  /** What to do when a SECOND peer also declares itself a Gateway: true → keep the link but not as fallback,
   *  false → treat it as a wiring error and drop it. Same level as isGateway — an App-wide build-time switch. */
  readonly autoMultiGatewayDowngrade: boolean
  /**
   * The shared communication-stack bus. Everything observable about this App flows here: `nacp:*` from the
   * protocol layer, `nact:*` from the transport layer, `napp:*` from this facade.
   *
   * A FULL EventBus, not a read-only view — `emit` included, deliberately. A host assembling this App may need
   * to fold its own signals into the same observation stream, and test/debug injection needs the same door.
   * Observation is by convention listen-only; forging a `nacp:*` name would just mislead other observers.
   */
  readonly bus = new EventBus()
  readonly nacp: NACP
  readonly nact: NACT
  /**
   * Processors this NApp had to create for you because `start()` found the kind unbound. Bind your own and
   * these stay empty. Exposed because an auto-created processor still needs to be reachable — you must be
   * able to register handlers on it, observe its bus, and inspect it.
   *
   * NApp knowing NACEB / NACAB is fine: it is the ASSEMBLY layer, and knowing what it assembles is its job.
   * The layer that must never know them is NACP, which sees only the `Processor` contract.
   */
  readonly default: { NACEB?: NACEB; NACAB?: NACAB } = {}

  private explicitDecl?: Declaration
  private processors = new Map<RequestKind, Processor>()   // NApp owns; NACP reads via public getProcessor()
  private serverSpecs: TransportSpec[]
  private handles: ServerHandle[] = []
  /** Set by start(). `connect()` requires it: one startup order for every App, whether or not it exposes
   *  entries. A client-only App (`server[]` empty) still calls start() — there it only settles the Processors. */
  private started = false
  /** Irreversible once set. Locks the outbound API — except the unregister frames stop() itself sends, and
   *  their responses, which must still flow for a graceful goodbye. */
  private stopping = false

  constructor(o: NAppOpts) {
    if (!o.id) throw nappInternal('no-id', 'NApp: id required')
    this.id = o.id
    this.explicitDecl = o.decl
    this.serverSpecs = o.server ?? []
    this.isGateway = o.opt?.isGateway ?? false
    this.autoMultiGatewayDowngrade = o.opt?.autoMultiGatewayDowngrade ?? false

    // Both children hold ONE thing: `this.napp`, NApp's public face. There is no private-capability box for
    // either of them — everything they need is public here (`bus`, `getProcessor`, each other's one entry
    // point), so the layer being crossed is visible at every call site.
    //
    // The reverse reference is also what breaks the construction cycle: NACP stores this NApp now but reads
    // `this.napp.nact` only at CALL time, by which point the line below has built it.
    this.nacp = new NACP(this)
    this.nact = new NACT(this)
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

  /** The Processor bound for a kind, or undefined if none is. NACP calls this on every inbound request —
   *  `processors` itself stays private so the only way IN is `bindProcessor` (which is also where this App
   *  registers its own abilities); what is public is the LOOKUP, not the table. */
  getProcessor(kind: RequestKind): Processor | undefined { return this.processors.get(kind) }

  /** Bind the Processor for a kind. NACP only ever sees the `Processor` contract — it does not import or
   *  know NACEB/NACAB, so anything satisfying the contract can be bound here.
   *
   *  Binding an ability processor is also when this App registers its OWN abilities (the `NApp.` family) into
   *  it, through the contract's ordinary `register` port. So a processor you supplied carries them just as a
   *  stock one does, and the processor cannot tell that registration apart from a user's. */
  bindProcessor(kind: RequestKind, processor: Processor) {
    this.processors.set(kind, processor)
    if (kind === 'ability') this.registerOwnAbilities(processor as AbilityProcessor)
  }

  /** Register this App's own `NApp.`-prefixed abilities into the bound ability processor. `execute` closes
   *  over the App itself, so the processor reaches App state without knowing NApp or NACP exists. */
  private registerOwnAbilities(proc: AbilityProcessor) {
    if (typeof proc.register !== 'function')
      throw nappInternal('not-an-ability-processor',
        'an ability Processor must implement register(item) — this App registers its own NApp.* abilities through it')
    for (const item of appAbilities(this)) proc.register(item)
  }

  /** Both kinds MUST have a carrier: register declares this App's abilities, and `NApp.introduce` has to be
   *  answerable — "no processor for this kind" is not an acceptable answer to either. Anything you left
   *  unbound gets a stock instance here, reachable via `app.default`.
   *
   *  Called from ONE place, `start()`. It used to be called from `connect()` too, because a client-only App
   *  never started; now `connect()` requires `start()`, so a single entry point covers every path. */
  private ensureProcessors() {
    if (!this.processors.has('event')) {
      this.default.NACEB = new NACEB({ pipelineHandlers: [], taskHandlers: [] })
      this.bindProcessor('event', this.default.NACEB.nacpAdaptor)
    }
    if (!this.processors.has('ability')) {
      this.default.NACAB = new NACAB()
      this.bindProcessor('ability', this.default.NACAB.nacpAdaptor)
    }
  }

  // ── lifecycle ──

  /**
   * Bring the App up: settle the Processors, then bring up every declared server entry. Nothing was listening
   * before this, and `connect()` is refused before this.
   *
   * A client-only App (`server[]` empty) still has to call it — the loop below simply does nothing, and what
   * matters is `ensureProcessors()`: an App that never listens still registers outward, still declares its
   * abilities, and still has to answer `NApp.introduce`. Requiring it of everyone buys ONE startup order for
   * every App instead of two, which is worth more than saving a no-op call.
   *
   * Idempotent: calling it twice does not double-listen.
   */
  async start() {
    if (this.started) return
    this.ensureProcessors()
    for (const spec of this.serverSpecs) this.handles.push(await this.nact.listen(spec))
    this.started = true
  }

  /**
   * Shut the whole App down — the inverse of `start`. To drop just ONE peer and stay up, that is `disconnect`.
   *
   * Graceful, in the order the protocol requires:
   *   1. latch `stopping` (irreversible) so no new outbound work starts
   *   2. send unregister to every connected App and await their acknowledgements (or time out)
   *   3. fail every remaining waiter, off every listener, clear all four tables
   *   4. drop every peer and close every server entry
   * Steps 2 and 3 are ordered this way so the goodbye goes out while routes still exist.
   *
   * All three stack members name their full teardown `terminate`: NApp stops the App, NACP clears its state,
   * NACT drops its connections. One verb, one meaning — "everything this layer holds, gone".
   */
  async terminate() {
    if (this.stopping) return
    this.stopping = true
    await Promise.allSettled(this.nacp.listAppId().map(appId => this.nacp.unregister(appId)))
    this.nacp.terminate()
    await this.nact.terminate()
    this.handles = []
  }

  /**
   * Drop ONE peer gracefully — the exact inverse of `connect`. The App stays up: it keeps listening, its other
   * links are untouched, and this same appId can be dialled again afterwards.
   *
   * Two steps, in the order the protocol requires:
   *   1. send unregister and await the peer's acknowledgement, so it clears our appId on purpose rather than
   *      inferring it from a dead socket
   *   2. close the physical connection
   * A peer that never answers does not block us — the unregister's own 10s timeout expires and step 2 runs
   * anyway. NACP's own table cleanup is NOT done here: it rides `nact:peer:disconnect`, which step 2 produces,
   * so the same path handles a deliberate disconnect and a cable pull.
   *
   * Returns false when that appId was not connected in the first place — nothing to do, not an error.
   *
   * The pairing is deliberate, and so is the asymmetry of scope:
   *   start()   ⇄ terminate()    the whole App
   *   connect() ⇄ disconnect()   one peer
   */
  async disconnect(appId: string): Promise<boolean> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')
    const peerId = this.nacp.getAppPeerId(appId)
    if (!peerId) return false
    // Swallow the rejection: a peer that is already gone (or silent until timeout) must not stop us from
    // closing the socket, and the caller asked for a disconnect, not for a guarantee that it was acknowledged.
    await this.nacp.unregister(appId).catch(() => { /* gone, or never answered */ })
    await this.nact.closePeer(peerId)
    return true
  }

  /**
   * Dial a peer and complete the register handshake. `expect` is mandatory — the dialler must know who it
   * means to reach, and that name goes straight into register's `to`. The peer answers only if that name is
   * its own; a mismatch is silently dropped and surfaces as a failed register.
   *
   * Requires `start()` first, EVEN for a client-only App. The handshake declares this App's abilities, so the
   * Processors have to be settled before it — and rather than settle them here as a second entry point, there
   * is one startup order for everyone: start, then connect. A client-only App's start() just settles the
   * Processors and listens to nothing.
   *
   * This method owns exactly one thing: the physical dial. Everything after it is protocol, so it all lives in
   * `nacp.register` — bind, handshake, identity check, Gateway slot, online announcement, and the teardown
   * when any of it fails.
   *
   * There is deliberately NO gateway argument. Gateway identity is declared once, by the Gateway itself, in
   * `new NApp({opt:{isGateway:true}})`, and both sides learn it from the register exchange. Whether a peer
   * becomes this App's outbound fallback is therefore decided by that peer's declaration alone — one rule,
   * one writer. The slot is first-come-first-served; if a second peer also declares Gateway, the behaviour
   * depends on `autoMultiGatewayDowngrade` (keep the link as a plain App link, or reject the connection).
   */
  async connect(expect: string, target: TransportSpec): Promise<void> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')
    if (!this.started)
      throw nappInternal('not-started', 'NApp: call start() before connect() — a client-only App must start() too')
    const peer = await this.nact.dial(target)
    if (!await this.nacp.register(expect, peer))
      throw nappOutbound('register-failed', `register with '${expect}' failed; the cause is on nacp:internal:register:error`)
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

  /**
   * Subscribe to an event name on a peer's bus. Returns a PAIR, because the two halves become usable at
   * different moments and pretending otherwise would cost you notifies:
   *
   *   const [sub, stream] = app.subscribe('core', 'job:*')
   *   for await (const chunk of stream) { … }        // usable immediately
   *   const res = await sub                           // usable once the peer confirms
   *   res.payload.targetSubId                         // the id to unsubscribe with
   *
   * `stream` is live the moment this returns — the local listener is filed before the subscribe frame goes
   * out, so nothing that arrives during the round trip is lost. `sub` has to wait for the peer's response,
   * which is the ordinary `ResponseMessage`: `meta.isOk` says whether the subscription took, and
   * `payload.targetSubId` carries the id `unsubscribe` wants, under the very name it takes.
   *
   * `targetListener` still works and COEXISTS with the stream: a notify goes to both. Use whichever fits —
   * a callback for fire-and-forget handling, the stream when you want back-pressure and `for await`.
   *
   * Leaving the loop (`break` / `return` / throw) CANCELS the subscription — it sends a real unsubscribe, so
   * the callback stops receiving too. Ending the iteration and keeping the subscription is not a state worth
   * having; if you want the subscription without consuming here, just do not iterate.
   *
   * The stream buffers up to 1024 unconsumed notifies; past that the oldest is dropped and
   * `napp:internal:notify:warning` fires with `reason: 'stream-overflow'`.
   */
  subscribe(
    to: string, targetSubName: string, targetListener?: (payload: any, msg: NotifyMessage) => void,
  ): [Promise<ResponseMessage>, AsyncIterable<any>] {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')

    // The subId is the subscribe message's own id — that is what the peer files its half under, stamps into
    // every notify's parentId, and returns as `payload.targetSubId`. We cannot mint our own. But the stream's
    // cancel path needs it SYNCHRONOUSLY (a `break` can precede the peer's response), so NACP hands it back
    // through `onSubId`, which it calls before the frame goes out.
    let subId!: string
    const stream = new NotifyStream({
      onOverflow: (dropped: unknown) => this.bus.emit(NAppInternal.notifyWarning, {
        appId: to, subId, targetSubName, dropped, reason: 'stream-overflow',
      }),
      // Consumer walked away → cancel for real. Swallow the rejection: the subscription may already be gone
      // (peer disconnected, terminate ran), and a `break` must not produce an unhandled rejection.
      onCancel: () => { void this.nacp.unsubscribe(to, subId)?.catch(() => {}) },
    })

    const sub = Promise.resolve(
      this.nacp.subscribe(
        to, targetSubName,
        (payload, msg) => { targetListener?.(payload, msg); stream.push(payload) },
        { onEnd: () => stream.end(), onSubId: (id) => { subId = id } },
      )!,
    )

    return [sub, stream]
  }

  /** Cancel a subscription on a peer (a remote `off`).
   *  Always a real unsubscribe — AutoSub closes its own halves inside NACP and never surfaces here, so
   *  `nacp.unsubscribe` returns a Promise (it only returns void for the `autoSub` half). */
  unsubscribe(to: string, targetSubId: string): Promise<ResponseMessage> {
    if (this.stopping) return Promise.reject(nappOutbound('stopping', 'NApp is stopping'))
    return this.nacp.unsubscribe(to, targetSubId)!
  }

  /** Push one process chunk to a subscriber. Resolves `true` once the frame is handed to NACT, `false` if it
   *  never left — no route, or the peer is gone (cause on `nacp:internal:route:error`). A notify is one-way,
   *  so this is the only signal there is; no response will arrive later to reveal the failure.
   *  Resolves `false` when the App is stopping, for the same reason: nothing was sent. */
  async notify(
    to: string,
    opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any },
  ): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.notify(to, opt)
  }

  /** Answer a request by hand. Normally the Processor's `onResponse` callback does this for you.
   *  Resolves `true` once the frame is handed to NACT — same contract as `notify`. */
  async response(
    to: string,
    opt: { parentId: string; isOk: boolean; whyNotOk?: string; kind?: RequestKind; decl?: Declaration; payload?: any },
  ): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.response(to, opt)
  }

  // ── observation ──
  //
  // There is deliberately NO `on` / `once` / `off` here. `bus` is a full, public EventBus, so wrapping three of
  // its four subscribe doors in one-line forwards bought nothing and cost a second way to spell the same thing
  // — and it left `asyncListenOnce` out, so anyone awaiting an event had to switch to `app.bus` anyway.
  // Observation goes through `app.bus` directly: listen / listenOnce / asyncListenOnce / off / emit.

  /** Every appId currently bound to a peer. Named `list…` like NACT's `listPeerId` — across NASDK, a method
   *  that returns "all of X" is `listX`. */
  listConnectedApp(): string[] { return this.nacp.listAppId() }
}
