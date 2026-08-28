/**
 * NApp — NASDK's facade: assembles NACP + NACT over one shared EventBus, holds the Processor binding table
 * (read by NACP via getProcessor) and the server entries to expose. Outbound methods forward to NACP.
 */

import { EventBus } from '../EventBus.ts'
import type { AbilityProcessor, EventProcessor, Processor } from '../types.ts'
import { NACP } from '../NACP/NACP.ts'
import { NACT } from '../NACT/NACT.ts'
// Stock Processors, imported as VALUES: assembled when a kind is left unbound.
import { NACEB } from '../NACEB/NACEB.ts'
import { NACAB } from '../NACAB/NACAB.ts'
import type { ServerHandle, TransportSpec } from '../NACT/types.ts'
import type {
  Declaration, NotifyMessage, RequestKind, ResponseMessage, SignalOpt,
} from '../NACP/types.ts'
import type { NAppOpts } from './types.ts'
import type { AbilityRequestHandle, EventRequestHandle, SubscribeHandle } from './types.ts'
import { appAbilities } from './abilities.ts'
import { nappInternal, nappOutbound } from './errors.ts'
import { NAppInternal } from './events.ts'
import { NotifyStream } from './notifyStream.ts'

type ProcessorByKind = { event: EventProcessor; ability: AbilityProcessor }

const DEFAULT_ACK_TIMEOUT_MS = 10_000        // liveness threshold, not a work budget
const DEFAULT_RECONNECT_GRACE_MS = 120_000   // covers a process restart or network blip
const DEFAULT_QUEUE_MAX_BYTES = 4 * 1024 * 1024 * 1024   // ≥ one max-size frame (2GiB)
const DEFAULT_QUEUE_MAX_COUNT = 1024

export class NApp {
  readonly id: string
  readonly isGateway: boolean
  /** Second declaring Gateway: true → keep link but not as fallback; false → wiring error, drop. */
  readonly autoMultiGatewayDowngrade: boolean
  readonly ackTimeoutMs: number
  readonly reconnectGraceMs: number
  readonly queueMaxBytes: number
  readonly queueMaxCount: number
  /** Shared bus carrying nacp:* / nact:* / napp:* events. Full EventBus: hosts may fold their own signals in;
   *  observation is listen-only by convention. */
  readonly bus = new EventBus()
  readonly nacp: NACP
  readonly nact: NACT
  /** Auto-created processors from start(); empty if you bound your own. */
  readonly default: { NACEB?: NACEB; NACAB?: NACAB } = {}

  private explicitDecl?: Declaration
  private processors = new Map<RequestKind, Processor>()   // NApp owns; NACP reads via public getProcessor()
  private serverSpecs: TransportSpec[]
  private handles: ServerHandle[] = []
  private started = false    // set by start(); connect() requires it
  private stopping = false   // irreversible; locks the outbound API except stop()'s own goodbyes

  constructor(o: NAppOpts) {
    if (!o.id) throw nappInternal('no-id', 'NApp: id required')
    this.id = o.id
    this.explicitDecl = o.decl
    this.serverSpecs = o.server ?? []
    this.isGateway = o.opt?.isGateway ?? false
    this.autoMultiGatewayDowngrade = o.opt?.autoMultiGatewayDowngrade ?? false
    this.ackTimeoutMs = o.opt?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    this.reconnectGraceMs = o.opt?.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS
    this.queueMaxBytes = o.opt?.queueMaxBytes ?? DEFAULT_QUEUE_MAX_BYTES
    this.queueMaxCount = o.opt?.queueMaxCount ?? DEFAULT_QUEUE_MAX_COUNT

    // Both children hold only `this.napp` and read each other through it at call time.
    this.nacp = new NACP(this)
    this.nact = new NACT(this)
  }

  // ── declaration ──

  /** Explicit decl wins; otherwise aggregated from bound processors. */
  buildDecl(): Declaration {
    if (this.explicitDecl) return this.explicitDecl
    const events = this.processors.get('event')?.list() ?? []
    const abilities = this.processors.get('ability')?.list() ?? []
    return { events, abilities }
  }

  getProcessor<K extends RequestKind>(kind: K): ProcessorByKind[K] | undefined {
    return this.processors.get(kind) as ProcessorByKind[K] | undefined
  }

  /** Bind the Processor for a kind; binding an ability processor also registers this App's own NApp.*
   *  abilities into it through the ordinary register port. */
  bindProcessor<K extends RequestKind>(kind: K, processor: ProcessorByKind[K]) {
    this.processors.set(kind, processor)
    if (kind === 'ability') this.registerOwnAbilities(processor as AbilityProcessor)
  }

  /** Register this App's own `NApp.`-prefixed abilities into the bound ability processor. */
  private registerOwnAbilities(proc: AbilityProcessor) {
    if (typeof proc.register !== 'function')
      throw nappInternal('not-an-ability-processor',
        'an ability Processor must implement register(item) — this App registers its own NApp.* abilities through it')
    for (const item of appAbilities(this)) proc.register(item)
  }

  /** Both kinds must have a carrier (register + NApp.introduce have to be answerable); anything left
   *  unbound gets a stock instance, reachable via `app.default`. Called only from start(). */
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

  /** Bring the App up: settle Processors, then listen on every declared server entry. Required even for a
   *  client-only App (it still must answer NApp.introduce). Idempotent. */
  async start() {
    if (this.started) return
    this.ensureProcessors()
    for (const spec of this.serverSpecs) this.handles.push(await this.nact.listen(spec))
    this.started = true
  }

  /** Shut the whole App down — graceful: latch stopping, unregister every target, then teardown all layers.
   *  For dropping ONE peer use disconnect(). */
  async terminate(opt: { isOnlineOnly?: boolean } = {}) {
    if (this.stopping) return
    this.stopping = true
    // Online only by default: an offline App's unregister would sit in the backlog until handshake timeout.
    const targets = opt.isOnlineOnly === false ? this.nacp.listAppId() : this.nacp.listOnlineAppId()
    await Promise.allSettled(targets.map(appId => this.nacp.unregister(appId)))
    this.nacp.terminate()
    await this.nact.terminate()
    this.handles = []
  }

  /** Drop ONE peer gracefully: unregister → await ack (or timeout) → close the connection. The App stays up.
   *  Returns false when that appId was not connected. */
  async disconnect(appId: string): Promise<boolean> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')
    const peerId = this.nacp.getAppPeerId(appId)
    if (!peerId) return false
    await this.nacp.unregister(appId).catch(() => { /* gone, or never answered */ })
    await this.nact.closePeer(peerId)
    return true
  }

  /** Dial a peer and complete the register handshake. Requires start() first (even client-only). No gateway
   *  argument: gateway identity comes from each side's declaration in the register exchange. */
  async connect(expect: string, target: TransportSpec): Promise<void> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')
    if (!this.started)
      throw nappInternal('not-started', 'NApp: call start() before connect() — a client-only App must start() too')
    const peer = await this.nact.dial(target)
    if (!await this.nacp.register(expect, peer))
      throw nappOutbound('register-failed', `register with '${expect}' failed; the cause is on nacp:internal:register:error`)
  }

  // ── outbound API (all forward to NACP; register/unregister are driven by connect/stop) ──

  /** Send a request and await its ONE terminal response. `onProcess` receives the process stream (event
   *  kinds only). Fire-and-forget = not awaiting the promise. */
  request(
    to: string,
    opt: { kind: 'event'; target?: string; payload?: any; onProcess?: (message: NotifyMessage) => void },
  ): EventRequestHandle
  request(
    to: string,
    opt: { kind: 'ability'; target?: string; payload?: any },
  ): AbilityRequestHandle
  request(
    to: string,
    opt: { kind: RequestKind; target?: string; payload?: any; onProcess?: (message: NotifyMessage) => void },
  ): EventRequestHandle | AbilityRequestHandle {
    if (this.stopping) {
      return { reqId: '', response: Promise.reject(nappOutbound('stopping', 'NApp is stopping')) }
    }
    if (opt.kind === 'ability') return this.nacp.request(to, opt)

    let reqId = ''
    const stream = new NotifyStream<NotifyMessage>({
      max: this.queueMaxCount,
      onOverflow: (dropped: unknown) => this.bus.emit(NAppInternal.notifyWarning, {
        appId: to, subId: reqId, targetSubName: `nacp:event:${reqId}:process`, dropped, reason: 'stream-overflow',
      }),
    })
    const call = this.nacp.request(to, {
      ...opt,
      onProcess: (_chunk, message) => { opt.onProcess?.(message); stream.push(message) },
      onProcessEnd: () => stream.end(),
    })
    reqId = call.reqId
    return { ...call, stream }
  }

  /** Send a reliable one-way Signal to an active Event request. Resolves when the Signal itself is ACKed. */
  async signal(to: string, opt: SignalOpt): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.signal(to, opt)
  }

  /** Leaving the loop (`break`/throw) CANCELS the subscription via a real unsubscribe. */
  subscribe(
    to: string, targetSubName: string, targetListener?: (message: NotifyMessage) => void,
  ): SubscribeHandle {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')

    let subId!: string
    const stream = new NotifyStream<NotifyMessage>({
      max: this.queueMaxCount,
      onOverflow: (dropped: unknown) => this.bus.emit(NAppInternal.notifyWarning, {
        appId: to, subId, targetSubName, dropped, reason: 'stream-overflow',
      }),
      onCancel: () => { void this.nacp.unsubscribe(to, subId)?.catch(() => {}) },
    })

    const sub = Promise.resolve(
      this.nacp.subscribe(
        to, targetSubName,
        (_payload, message) => { targetListener?.(message); stream.push(message) },
        { onEnd: () => stream.end(), onSubId: (id) => { subId = id } },
      )!,
    )

    return { subId, response: sub, stream }
  }

  /** Cancel a subscription on a peer (a remote `off`). */
  unsubscribe(to: string, targetSubId: string): Promise<ResponseMessage> {
    if (this.stopping) return Promise.reject(nappOutbound('stopping', 'NApp is stopping'))
    return this.nacp.unsubscribe(to, targetSubId)!
  }

  /** Push one process chunk to a subscriber. Resolves once the notify DEPARTS; false when it can never leave. */
  async notify(
    to: string,
    opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any },
  ): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.notify(to, opt)
  }

  /** Answer a request by hand (normally Processor's onResponse does this). Resolves once ACKNOWLEDGED. */
  async response(
    to: string,
    opt: { parentId: string; isOk: boolean; whyNotOk?: string; kind?: RequestKind; decl?: Declaration; payload?: any },
  ): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.response(to, opt)
  }

  // ── observation: go through app.bus directly ──

  /** Reachable appIds by default; pass isOnlineOnly:false to include offline ones still held. */
  listConnectedApp(opt: { isOnlineOnly?: boolean } = {}): string[] {
    return opt.isOnlineOnly === false ? this.nacp.listAppId() : this.nacp.listOnlineAppId()
  }
}
