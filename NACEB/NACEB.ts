/**
 * NACEB — Nyirusu Application Control Event Bus. The assembly.
 *
 * Three FSMControllers sit side by side under NACEB, "asking" each other via lazy getters that NACEB
 * injects. alertTick self-locks (ticking flag held across awaits) and each tick awaits the three
 * controller.nextTick() in order (task → pipeline → event). Queues hold full instance objects across
 * all three layers: the object IS the state IS the capability.
 *
 * Transition is uniform, two-beat:
 *   before: emit `naceb:{layer}:{state}:before:{id}` + await user beforeT{State} hook (may intervene/veto)
 *   mutate state
 *   after : emit `naceb:{layer}:{state}:after:{id}`  + run user afterT{State} hook
 *
 * Result delivery: NACEB never broadcasts final. The terminal signal rides the done/failure transition
 * event + afterT{Done|Failure} hook; the terminal result is taken solely via consumeEvent(id)'s return value.
 */

import { EventBus, readonlyView } from '../EventBus.ts'
import type { ReadonlyBus } from '../EventBus.ts'
import { uid } from '../utils/id.ts'
import { TaskHandler } from './types.ts'
import type {
  PipelineHandler, NACEBHooks, EventInterface, PushOpts, NACEBRef, EventAlias, Event, RuntimeEmit,
  NACEBPrivateRef, THookHandler as THookHandlerFn,
} from './types.ts'
import { TaskFSMController, builtinHandlers } from './controller/TaskFSMController.ts'
import { nacebInbound, nacebInternal } from './errors.ts'
import type { TaskInstance } from './controller/TaskFSMController.ts'
import { PipelineFSMController } from './controller/PipelineFSMController.ts'
import { EventFSMController } from './controller/EventFSMController.ts'
import type { EventInstance } from './controller/EventFSMController.ts'
import { NACPAdaptor } from './NACPAdaptor.ts'

export class NACEB {
  private taskController: TaskFSMController
  private pipelineController: PipelineFSMController
  private eventController: EventFSMController
  private hooks: NACEBHooks = {}
  readonly eventBus = new EventBus()
  readonly pipelineHandlers = (() => {
    const _map = new Map<string, PipelineHandler>()
    return { register: (h: PipelineHandler) => { _map.set(h.name, h) }, list: () => [..._map.values()], remove: (name: string) => { _map.delete(name) }, get: (name: string) => _map.get(name), _map }
  })()
  readonly taskHandlers = (() => {
    const _map = new Map<string, TaskHandler>()
    return {
      register: (h: TaskHandler) => {
        if (h.name.startsWith('$')) throw new Error(`handler name '${h.name}' uses the reserved $ prefix and cannot be registered`)
        _map.set(h.name, h)
      }, list: () => [..._map.values()], remove: (name: string) => { _map.delete(name) }, get: (name: string) => _map.get(name), _map,
    }
  })()
  readonly eventAlias = (() => {
    const _map = new Map<string, EventAlias>()
    return { register: (alias: EventAlias) => { _map.set(alias.eventName, alias) }, list: () => [..._map.values()], remove: (eventName: string) => { _map.delete(eventName) }, get: (eventName: string) => _map.get(eventName), _map }
  })()
  private clock: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private _emit: RuntimeEmit
  private ref!: NACEBPrivateRef   // 私有能力盒，构造内填充后注入三个 Controller
  private _nacpAdaptor: NACPAdaptor | null = null

  constructor(opts: {
    eventAlias?: EventAlias[]
    pipelineHandlers: PipelineHandler[]
    taskHandlers: TaskHandler[]
  }) {
    // Unified internal channel: every runtime signal is an EventBus event `naceb:runtime:{level}:{id}`;
    // nothing printed by default.
    this._emit = (level, id, payload) => this.eventBus.emit(`naceb:runtime:${level}:${id}`, payload)
    this.eventBus.onError = (key, err) =>
      this.eventBus.emit(`naceb:runtime:error:bus`, { layer: 'bus', id: 'bus', msg: `observer error @${key}: ${(err as any)?.message ?? String(err)}`, opt: { key, error: err } })
    for (const a of opts.eventAlias ?? []) this.eventAlias.register(a)
    for (const p of opts.pipelineHandlers) this.pipelineHandlers.register(p)
    for (const h of opts.taskHandlers) this.taskHandlers.register(h)

    // THookHandler: emit the T event (readonlyView onto `this`) + run that state's hooks in order.
    const THookHandler: THookHandlerFn = async (layer, state, ph, id, obj, hks) => {
      this.eventBus.emit(`naceb:${layer}:${state}:${ph}:${id}`, undefined, readonlyView(obj))
      if (!hks) return
      if (ph === 'before') { for (const fn of hks) await fn.call(obj) }
      else for (const fn of hks) {
        try { await fn.call(obj) }
        catch (e) { this._emit('error', id, { layer, id, msg: `afterT hook threw: ${(e as any)?.message ?? String(e)}`, opt: { state, phase: ph, error: e } }) }
      }
    }

    // ref: NACEB's private-capability box, injected into the three controllers.
    this.ref = {
      THookHandler,
      emit: this._emit,
      emitMessage: (t: TaskInstance, chunk: unknown) => this._emit('message', t.eventId, {
        layer: 'task', id: t.eventId, opt: { taskId: t.id, eventId: t.eventId, pipelineId: t.pipeline.id, chunk },
      }),
      alertTick: (from: string) => this.alertTick(from),
      ensureClock: () => this.ensureClock(),
      forceCleanEventUnderLayer: (eventId: string) => this.forceCleanEventUnderLayer(eventId),
      taskController: undefined as any,               // 下面 new 出来后回填
      pipelineController: () => this.pipelineController,
      eventController: () => this.eventController,
    }

    this.taskController = new TaskFSMController(this, this.ref)
    this.pipelineController = new PipelineFSMController(this, this.ref)
    this.eventController = new EventFSMController(this, this.ref)
    this.ref.taskController = this.taskController      // 回填（Task 无构造环，直接持引用）

    const ref: NACEBRef = {
      pushEvent: (e, o) => this.pushEvent(e, o),
      getEvent: (id) => this.getEvent(id),
      consumeEvent: (id) => this.consumeEvent(id),
    }
    for (const h of builtinHandlers(ref)) this.taskController.registerBuiltin(h)
  }

  registerPipelineHandler(h: PipelineHandler) { this.pipelineHandlers.register(h) }
  registerTaskHandler(h: TaskHandler) { this.taskHandlers.register(h) }
  registerEventAlias(alias: EventAlias) { this.eventAlias.register(alias) }
  on<K extends keyof NACEBHooks>(hook: K, fn: NonNullable<NACEBHooks[K]>) { (this.hooks as any)[hook] = fn }

  /** Read-only observation view of the internal EventBus (subscribe/unsubscribe only, no emit).
   *  Internally NACEB uses this.eventBus directly; external consumers get this view. */
  get eventBusObs(): ReadonlyBus { return this.eventBus.readonly }

  pushEvent(input: Omit<EventInterface, 'id' | 'name' | 'pipelineName'> & { id?: string; name?: string; pipelineName?: string }, opts?: PushOpts): string {
    const id = input.id ?? uid('event')
    const alias = input.name ? this.eventAlias.get(input.name) : undefined
    const pipelineName = alias?.pipelineName ?? input.pipelineName
    if (!pipelineName)
      throw nacebInbound('unresolved-pipeline', `event name '${input.name ?? '(none)'}' not in eventAlias and no pipelineName carried`)
    const name = input.name ?? id
    const e: EventInterface = { ...input, id, name, pipelineName }
    if (this.hooks.beforePushEvent?.(e)?.reject)
      throw nacebInternal('push-vetoed', `pushEvent rejected by beforePushEvent: ${id}`)
    if (!this.pipelineController.isRegistered(e.pipelineName)) throw nacebInternal('unregistered-pipeline', `unknown pipeline '${e.pipelineName}'`)
    const ev = this.eventController.push(e, opts)
    this.hooks.afterPushEvent?.(e)
    this.ensureClock()
    if (opts?.bypassIdle) ev.start()
    return id
  }

  listEventAlias(): Event[] {
    return [...this.eventAlias.list()].map(a => ({ name: a.eventName, description: a.description }))
  }

  get nacpAdaptor(): NACPAdaptor {
    return this._nacpAdaptor ??= new NACPAdaptor(this)
  }

  getEvent(id: string): EventInstance | null { return this.eventController.getById(id) }
  listEvent(): EventInstance[] { return this.eventController.queue.slice() }
  consumeEvent(id: string): unknown { return this.eventController.consume(id) }

  /**
   * Force-clean one event's lower live orphans (task + pipeline), called from the event layer's crash chain.
   * Fully blocking, same-beat: stop each task (force bypasses the builtin $ refusal) → consume task →
   * consume pipeline. Does not touch the event's own failure.
   */
  private async forceCleanEventUnderLayer(eventId: string): Promise<void> {
    for (const t of this.taskController.findTaskByEventId(eventId)) {
      if (t.status === 'running' || t.status === 'pending') await t._stop(true)
      t.consume()
    }
    this.pipelineController.getByEventId(eventId)?.consume()
  }

  private async alertTick(_from: string = '?') {
    // Collision (ticking=true) → drop this reminder; progression sources are redundant enough that a dropped
    // reminder always has a follow-up (veto retry re-fires via self re-fire, not this reminder).
    if (this.ticking) return
    this.ticking = true
    let moved = false
    try {
      const t = await this.taskController.nextTick()
      const p = await this.pipelineController.nextTick()
      const e = await this.eventController.nextTick()
      moved = t || p || e
    } finally { this.ticking = false }
    // moved → re-fire a beat. This is the single re-fire point.
    if (moved) {
      setTimeout(() => this.alertTick('self'), 0)
    }
  }

  private ensureClock() {
    if (this.clock) return
    this.clock = setInterval(() => {
      if (!this.eventController.hasLive()) { clearInterval(this.clock!); this.clock = null; return }
      this.alertTick('clock')
    }, 50)
  }
}
