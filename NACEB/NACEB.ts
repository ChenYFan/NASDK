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
    // Unified internal channel: every runtime signal (transition logs, errors, warnings, process
    // output) is an EventBus event `naceb:runtime:{level}:{id}` — no injected log closure. An observer
    // subscribes `naceb:runtime:log:*` (or error/warning/message) to see internals; by default nothing
    // is printed (a pure bus emit), symmetric with the T-event surface.
    this._emit = (level, id, payload) => this.eventBus.emit(`naceb:runtime:${level}:${id}`, payload)
    this.eventBus.onError = (key, err) =>
      this.eventBus.emit(`naceb:runtime:error:bus`, { layer: 'bus', id: 'bus', msg: `observer error @${key}: ${(err as any)?.message ?? err}`, opt: { key, error: err } })
    for (const a of opts.eventAlias ?? []) this.eventAlias.register(a)
    for (const p of opts.pipelineHandlers) this.pipelineHandlers.register(p)
    for (const h of opts.taskHandlers) this.taskHandlers.register(h)

    // THookHandler：触发一个 T 事件 = emit T 事件（readonlyView 骑 this）+ 顺序跑该状态 hook 列表。
    // 概念上 emit 是 hook 列表第 0 位；实现上先 emit 后跑 hook（等价）。原 _phase。
    const THookHandler: THookHandlerFn = async (layer, state, ph, id, obj, hks) => {
      this.eventBus.emit(`naceb:${layer}:${state}:${ph}:${id}`, undefined, readonlyView(obj))
      if (!hks) return
      if (ph === 'before') { for (const fn of hks) await fn.call(obj) }
      else for (const fn of hks) {
        try { await fn.call(obj) }
        catch (e) { this._emit('error', id, { layer, id, msg: `afterT hook threw: ${(e as any)?.message ?? e}`, opt: { state, phase: ph, error: e } }) }
      }
    }

    // ref：NACEB 私有能力打包盒，注入给三个 Controller（同一引用）。controller 互引用闭包/惰性读 this，破构造环。
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
   * 私有：**只强清该 event 的下层活孤儿**（task + pipeline）。event 层 beforeT hook 抛非 VetoT 崩溃时，
   * 由 EventInstance._transition 的崩溃链调用——因为 tick 不从上往下同步，event 崩了下面的 task/pipeline
   * 是活孤儿，必须自上而下同刻强清。完全阻塞、同刻：
   *   ① 停 task：findTaskByEventId → 每个 `_stop(true)`（force 绕过 builtin $ task 拒绝；内含 abort + 最多
   *      等 stopTimeoutMs，超时 emit 告知、execute Promise 后台自生自灭）。
   *   ② 消费 task（consume：取结果 + 移除）。③ 消费 pipeline（consume）。
   * **不碰 event 自己的 failure**——那由崩溃链随后的递归 `_transition('failure')` 统一落（三层崩溃链形状一致，
   * event 只多这一步「先清下层」）。
   */
  private async forceCleanEventUnderLayer(eventId: string): Promise<void> {
    for (const t of this.taskController.findTaskByEventId(eventId)) {
      if (t.status === 'running' || t.status === 'pending') await t._stop(true)   // force：连 builtin $ task 也停（内含 abort + 最多等 stopTimeoutMs）
      t.consume()   // 取结果 + 移除（无守卫，任何态可 consume）
    }
    this.pipelineController.getByEventId(eventId)?.consume()   // 消费 pipeline
  }

  private async alertTick(_from: string = '?') {
    // 撞锁（ticking=true）直接丢弃这次提醒：不需要 pendingTick/累加器补偿。因为推进的触发源足够冗余
    // （task 收束提醒 + moved 后的 self 补拍 + 50ms clock 兜底），被丢的提醒总有后续来源接上。
    // 唯一需要「撞锁不能丢」的场景是 veto 重试，但 veto 走「虚拟 moved」经 self 补拍出口（见
    // EventInstance._transition），不依赖这条提醒，所以这里丢弃是安全的。
    if (this.ticking) return
    this.ticking = true
    let moved = false
    try {
      const t = await this.taskController.nextTick()
      const p = await this.pipelineController.nextTick()
      const e = await this.eventController.nextTick()
      moved = t || p || e
    } finally { this.ticking = false }
    // moved（含 veto 的虚拟 moved）→ 补一拍。这是全局唯一补拍口。
    if (moved) {
      setTimeout(() => this.alertTick('self'), 0) //使用宏队列推进，~3.049ms/4step
      //queueMicrotask(() => this.alertTick('self')) //使用微队列推进，~2.739ms/4step，对延迟敏感任务可以使用，但是本队列会导致微队列阻塞，网络和IO会受到影响。
      //this.alertTick('self') //直接推进，~2.367ms/4step。可能有潜在的阻塞风险，此外特别多的tick连续推进会导致栈溢出，非常不建议使用。
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
