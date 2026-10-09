import { EventBus } from '../EventBus.ts'
import type { AbilityProcessor, EventProcessor, Processor } from '../types.ts'
import { NACP } from '../NACP/NACP.ts'
import { NACT } from '../NACT/NACT.ts'
import { NACEB } from '../NACEB/NACEB.ts'
import { NACAB } from '../NACAB/NACAB.ts'
import type { ServerHandle, TransportSpec } from '../NACT/types.ts'
import type {
  Declaration, NotifyMessage, RequestKind, ResponseMessage, SignalOpt,
} from '../NACP/types.ts'
import type { NAppOpts } from './types.ts'
import type { AbilityRequestHandle, EventRequestHandle, SubscribeHandle } from './types.ts'
import { appAbilities } from './abilities.ts'
import { Heartbeat, DEFAULT_HEARTBEAT_INTERVAL_MS } from './heartbeat.ts'
import { nappInternal, nappOutbound } from './errors.ts'
import { NAppInternal } from './events.ts'
import { NotifyStream } from './notifyStream.ts'

type ProcessorByKind = { event: EventProcessor; ability: AbilityProcessor }

const DEFAULT_ACK_TIMEOUT_MS = 10_000
const DEFAULT_RECONNECT_GRACE_MS = 120_000
const DEFAULT_QUEUE_MAX_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_QUEUE_MAX_COUNT = 1024

export class NApp {
  readonly id: string
  readonly isGateway: boolean
  readonly autoMultiGatewayDowngrade: boolean
  readonly ackTimeoutMs: number
  readonly reconnectGraceMs: number
  /** false = this App sends no heartbeats (it still answers them). */
  readonly heartbeatIntervalMs: number | false
  readonly queueMaxBytes: number
  readonly queueMaxCount: number
  readonly bus = new EventBus()
  readonly nacp: NACP
  readonly nact: NACT
  readonly default: { NACEB?: NACEB; NACAB?: NACAB } = {}

  private explicitDecl?: Declaration
  private processors = new Map<RequestKind, Processor>()
  private serverSpecs: TransportSpec[]
  private handles: ServerHandle[] = []
  private heartbeat: Heartbeat
  private started = false
  private stopping = false   // irreversible; locks the outbound API

  constructor(o: NAppOpts) {
    if (!o.id) throw nappInternal('no-id', 'NApp: id required')
    this.id = o.id
    this.explicitDecl = o.decl
    this.serverSpecs = o.server ?? []
    this.isGateway = o.opt?.isGateway ?? false
    this.autoMultiGatewayDowngrade = o.opt?.autoMultiGatewayDowngrade ?? false
    this.ackTimeoutMs = o.opt?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    this.reconnectGraceMs = o.opt?.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS
    const interval = o.opt?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    if (interval !== false && !(Number.isFinite(interval) && interval > 0))
      throw nappInternal('invalid-heartbeat-interval', 'NApp: heartbeatIntervalMs must be a positive number or false')
    this.heartbeatIntervalMs = interval
    this.queueMaxBytes = o.opt?.queueMaxBytes ?? DEFAULT_QUEUE_MAX_BYTES
    this.queueMaxCount = o.opt?.queueMaxCount ?? DEFAULT_QUEUE_MAX_COUNT

    this.nacp = new NACP(this)
    this.nact = new NACT(this)
    this.heartbeat = new Heartbeat(this, this.heartbeatIntervalMs)
  }

  buildDecl(): Declaration {
    if (this.explicitDecl) return this.explicitDecl
    const events = this.processors.get('event')?.list() ?? []
    const abilities = this.processors.get('ability')?.list() ?? []
    return { events, abilities }
  }

  getProcessor<K extends RequestKind>(kind: K): ProcessorByKind[K] | undefined {
    return this.processors.get(kind) as ProcessorByKind[K] | undefined
  }

  bindProcessor<K extends RequestKind>(kind: K, processor: ProcessorByKind[K]) {
    this.processors.set(kind, processor)
    if (kind === 'ability') this.registerOwnAbilities(processor as AbilityProcessor)
  }

  private registerOwnAbilities(proc: AbilityProcessor) {
    if (typeof proc.register !== 'function')
      throw nappInternal('not-an-ability-processor',
        'an ability Processor must implement register(item) — this App registers its own NApp.* abilities through it')
    for (const item of appAbilities(this, this.heartbeat)) proc.register(item)
  }

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

  async start() {
    if (this.started) return
    this.ensureProcessors()
    for (const spec of this.serverSpecs) this.handles.push(await this.nact.listen(spec))
    this.started = true
  }

  async terminate(opt: { isOnlineOnly?: boolean } = {}) {
    if (this.stopping) return
    this.stopping = true
    this.heartbeat.stop()
    // Default online-only: an offline peer's unregister would hang until handshake timeout.
    const targets = opt.isOnlineOnly === false ? this.nacp.listAppId() : this.nacp.listOnlineAppId()
    await Promise.allSettled(targets.map(appId => this.nacp.unregister(appId)))
    this.nacp.terminate()
    await this.nact.terminate()
    this.handles = []
  }

  async disconnect(appId: string): Promise<boolean> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')
    const peerId = this.nacp.getAppPeerId(appId)
    if (!peerId) return false
    await this.nacp.unregister(appId).catch(() => { /* gone, or never answered */ })
    await this.nact.closePeer(peerId)
    return true
  }

  /** Requires start() first, even for a client-only App. */
  async connect(expect: string, target: TransportSpec): Promise<void> {
    if (this.stopping) throw nappOutbound('stopping', 'NApp is stopping')
    if (!this.started)
      throw nappInternal('not-started', 'NApp: call start() before connect() — a client-only App must start() too')
    const peer = await this.nact.dial(target)
    if (!await this.nacp.register(expect, peer))
      throw nappOutbound('register-failed', `register with '${expect}' failed; the cause is on nacp:internal:register:error`)
    // The accepting side already beats at registration; the dialling side starts now.
    this.heartbeat.start(expect)
  }

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
    let reqId = ''
    if (opt.kind === 'ability') {
      const response = this.nacp.request(to, { ...opt, onReqId: (id) => { reqId = id } })
      return { reqId, response }
    }

    const stream = new NotifyStream<NotifyMessage>({
      max: this.queueMaxCount,
      onOverflow: (dropped: unknown) => this.bus.emit(NAppInternal.notifyWarning, {
        appId: to, subId: reqId, targetSubName: `nacp:event:${reqId}:process`, dropped, reason: 'stream-overflow',
      }),
    })
    const response = this.nacp.request(to, {
      ...opt,
      onProcess: (_chunk, message) => { opt.onProcess?.(message); stream.push(message) },
      onProcessEnd: () => stream.end(),
      onReqId: (id) => { reqId = id },
    })
    return { reqId, response, stream }
  }

  async signal(to: string, opt: SignalOpt): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.signal(to, opt)
  }

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

  unsubscribe(to: string, targetSubId: string): Promise<ResponseMessage> {
    if (this.stopping) return Promise.reject(nappOutbound('stopping', 'NApp is stopping'))
    return this.nacp.unsubscribe(to, targetSubId)!
  }

  async notify(
    to: string,
    opt: { parentId: string; targetSubName: string; hitSubName: string; payload?: any },
  ): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.notify(to, opt)
  }

  async response(
    to: string,
    opt: { parentId: string; isOk: boolean; whyNotOk?: string; kind?: RequestKind; decl?: Declaration; payload?: any },
  ): Promise<boolean> {
    if (this.stopping) return false
    return this.nacp.response(to, opt)
  }

  listConnectedApp(opt: { isOnlineOnly?: boolean } = {}): string[] {
    return opt.isOnlineOnly === false ? this.nacp.listAppId() : this.nacp.listOnlineAppId()
  }
}
