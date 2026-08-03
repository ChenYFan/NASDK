/**
 * NACEB types & contracts — status enums, transition tables, public contracts,
 * builtin task names, and NACEB-private helpers.
 *
 * State machines (failure is an absolute sink: any state may enter, none may leave):
 *   Event    : idle → blocked/queue → activating → processing ⇄ pending ⇄ paused → done/failure
 *   Pipeline : pending → running ⇄ paused → done/failure
 *   Task     : pending → running → done/stopped/failure ; stopped → pending (restart)
 */

import type { EventInstance } from './controller/EventFSMController.ts'

// ---- status ----
export type EventStatus =
  | 'idle' | 'blocked' | 'queue' | 'activating' | 'processing' | 'pending' | 'paused' | 'done' | 'failure'
export type PipelineStatus = 'pending' | 'running' | 'paused' | 'done' | 'failure'
export type TaskStatus = 'pending' | 'running' | 'done' | 'stopped' | 'failure'

// ---- public contracts ----

/**
 * TaskHandler: the only handler form. busyKeys present ⟹ blocked, absent ⟹ async.
 * Stateless and registered once as a reusable instance — execute() runs with `this` bound to the
 * TaskInstance (symmetric with PipelineHandler.next), so everything it needs is on `this`:
 * `this.input` (its input), `this.state` (scratch space), `this.abortSignal`,
 * `this.processingResultReport(chunk)`. The sole parameter is the upstream PipelineInstance —
 * a task is one-shot, so state that must survive across steps goes to `pCtx.state`, not `this.state`.
 */
export abstract class TaskHandler<R = unknown> {
  abstract readonly name: string
  readonly busyKeys?: string[]
  abstract execute(this: any): Promise<R>
}

/** Carrier for a task's normal (done) result. Only a done task has a response. */
export class TaskResponse {
  readonly result: unknown
  constructor(result: unknown) { this.result = result }
}

// ---- builtin reserved task names ($ prefix; the whole $ namespace is reserved, users cannot register into it) ----
export const TERMINAL = '$terminal'
export const FIRE4SUBEVENT = '$fire4SubEvent'
export const WAIT4SUBEVENT = '$wait4SubEvent'
export const BUILTIN_NAMES = [TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT]

/**
 * SubEvent spec: an independent child event a pipeline author names on the fly — pipeline + payload only.
 * Deliberately no scope/blockedBy: the child is an independent event, it neither joins the parent's
 * occupancy contention nor inherits its prerequisites.
 */
export interface SubEventSpec {
  pipelineName: string
  payload: unknown
}

/** NACEB reference handed to builtin privileged handlers at assembly time (ordinary user handlers never get it). */
export interface NACEBRef {
  pushEvent(e: Omit<EventInterface, 'id' | 'name' | 'pipelineName'> & { id?: string; name?: string; pipelineName?: string }, opts?: PushOpts): string
  getEvent(id: string): EventInstance | null
  consumeEvent(id: string): unknown
}

export interface PipelineStep {
  task: string
  input: unknown
}

/**
 * PipelineHandler: stateless, registered once, reused across all events.
 * next() is called with `this` bound to the PipelineInstance — handler state lives on the instance.
 */
export abstract class PipelineHandler {
  abstract readonly name: string
  readonly description?: string
  abstract next(this: any, lastResult: unknown): PipelineStep | undefined
}

/**
 * EventInterface: the complete data shape of an event (all fields required/filled).
 * At push time id/name/pipelineName may be omitted — pushEvent fills them in before constructing EventInterface.
 */
export interface EventInterface {
  readonly id: string      // auto-generated (event_<uuid>) if not supplied at push; validated if supplied
  name: string             // which declared event this is (e.g. 'AlertEvent'). Defaults to the eventId.
  pipelineName: string     // resolved at push: name → alias.pipelineName (overrides); else must be self-carried; absent → push rejected
  payload: unknown
  scope?: string
  blockedBy?: string[]     // prerequisites: other events' ids
  parentId?: string        // runtime-stamped by builtin $fire4/$wait4SubEvent; not user-written
}

/** NACEB reference handed to builtin privileged handlers at assembly time (ordinary user handlers never get it). */
export interface NACEBRef {
  pushEvent(e: Omit<EventInterface, 'id' | 'name' | 'pipelineName'> & { id?: string; name?: string; pipelineName?: string }, opts?: PushOpts): string
  getEvent(id: string): EventInstance | null
  consumeEvent(id: string): unknown
}

/**
 * Event alias: an eventName is an ALIAS for a pipeline plus a description.
 * eventName→pipelineName is many-to-one.
 */
export interface EventAlias {
  eventName: string
  pipelineName: string
  description: string
}

/** NACP Event declaration item (name + description). getAllEvents() returns Event[]. Symmetric with NACAB's Ability. */
export interface Event {
  name: string
  description: string
}

/** pushEvent behavior options (not event properties). */
export interface PushOpts {
  hooks?: EventHooks
  bypassIdle?: boolean
  bypassConsume?: boolean
}

/** Assembly-level hooks (push entry point, not transitions). */
export interface NACEBHooks {
  beforePushEvent?(e: EventInterface): void | { reject?: true }
  afterPushEvent?(e: EventInterface): void
}

/** Per-state transition hooks on an event. */
export interface EventHooks {
  beforeTBlocked?: HookFn<any>; afterTBlocked?: HookFn<any>
  beforeTQueue?: HookFn<any>; afterTQueue?: HookFn<any>
  beforeTActivating?: HookFn<any>; afterTActivating?: HookFn<any>
  beforeTProcessing?: HookFn<any>; afterTProcessing?: HookFn<any>
  beforeTPending?: HookFn<any>; afterTPending?: HookFn<any>
  beforeTPaused?: HookFn<any>; afterTPaused?: HookFn<any>
  beforeTDone?: HookFn<any>; afterTDone?: HookFn<any>
  beforeTFailure?: HookFn<any>; afterTFailure?: HookFn<any>
}

// ---- transition tables ----
export const EVENT_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  idle: ['blocked', 'queue'],
  blocked: ['queue'],
  queue: ['activating'],
  activating: ['processing', 'pending'],
  processing: ['pending', 'paused', 'done'],
  pending: ['processing', 'paused', 'done'],
  paused: ['processing', 'pending'],
  done: [],
  failure: [],
}
export const PIPELINE_TRANSITIONS: Record<PipelineStatus, PipelineStatus[]> = {
  pending: ['running', 'done'],
  running: ['paused', 'done'],
  paused: ['running'],
  done: [],
  failure: [],
}
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['running', 'stopped'],
  running: ['done', 'stopped'],
  stopped: ['pending'],
  done: [],
  failure: [],
}

// ---- NACEB-private helpers ----
export type HookFn<T> = (this: T) => void | Promise<void>
export const isBlocked = (b: string[]) => b.length > 0
export const cap = <S extends string>(s: S) => (s[0].toUpperCase() + s.slice(1)) as Capitalize<S>

/**
 * TransitionFunc — a side-effect run *inside* `_transition`, between the before-hook (veto point) and
 * the status change. This is where "building the lower-layer object" belongs: Event activating news
 * the PipelineInstance, Pipeline running dispatches the TaskInstance. Putting it here (not before the
 * `_transition` call) means a beforeT veto (throw) aborts the whole transition *before* any object is
 * built — nothing to roll back. The afterT hook still runs after the funcs, so the lower-layer object
 * exists when afterTActivating/afterTRunning attach lower-layer hooks. Order inside `_transition`:
 *   beforeT hook → transitionFuncs (in order) → change status → afterT hook.
 * A func may be async; it reads the *old* status (change happens after all funcs).
 */
export type TransitionFunc = () => void | Promise<void>

/**
 * Runtime observation events — the unified NACEB→EventBus internal channel, replacing the old injected
 * `_log` closure. Every internal signal (state-transition logs, hook errors, warnings, process output)
 * is emitted as `naceb:runtime:{level}:{id}`:
 *   - error   : a runtime error (e.g. an afterT hook threw). id = the triggering layer's instance id.
 *   - warning : a runtime warning. id = the triggering layer's instance id.
 *   - log     : an internal log line (transitions, idle/consume). id = the triggering layer's instance id.
 *   - message : formal process output from a running task. id = the eventId (process output belongs to the event).
 * payload is {layer,id,msg?,opt?}: layer/id/msg are the stable fields; anything level-specific (a
 * transition's from/to/same, an error's phase/state, a message's chunk/taskId) rides in `opt` — an
 * observer that doesn't care never touches it.
 */
export type RuntimeLevel = 'error' | 'warning' | 'log' | 'message'
export interface RuntimePayload {
  layer: string
  id: string
  msg?: string
  opt?: Record<string, unknown>
}
/** Injected by NACEB at assembly: emits `naceb:runtime:{level}:{id}` on the internal EventBus. */
export type RuntimeEmit = (level: RuntimeLevel, id: string, payload: RuntimePayload) => void

/** THookHandler：触发一个 T 事件 = emit T 事件（readonlyView 骑 this）+ 顺序跑该状态的 hook 列表。
 *  概念上 emit 是 hook 列表的第 0 位；实现上先 emit 后跑 hook（等价）。原 `_phase`。 */
export type THookHandler = (layer: string, state: string, phase: string, id: string, obj: any, hooks?: HookFn<any>[]) => Promise<void>

/**
 * NACEBPrivateRef — NACEB 把自己的**私有能力**打包成一个盒子，装配时注入给三个 Controller（同一引用）。
 * Controller 只持 `.naceb`（NACEB 的 public 成员，如 taskHandlers/eventBus）+ `.ref`（本盒，私有能力）。
 * 分界无歧义:naceb 的 private 成员通过 this.naceb 访问不到，一律走 this.ref。盒内成员不带下划线。
 * 三个 controller 互引也在盒里（pipeline/event 有构造环，用 lazy getter）。
 */
export interface NACEBPrivateRef {
  THookHandler: THookHandler
  emit: RuntimeEmit
  emitMessage: (t: any, chunk: unknown) => void
  alertTick: (from: string) => void
  /** 拉起 20Hz 基础时钟（幂等）。idle/paused 不撑时钟，故 start()/resume() 离开豁免态时必须调它重启。 */
  ensureClock: () => void
  forceCleanEventUnderLayer: (eventId: string) => Promise<void>
  taskController: import('./controller/TaskFSMController.ts').TaskFSMController
  pipelineController: () => import('./controller/PipelineFSMController.ts').PipelineFSMController
  eventController: () => import('./controller/EventFSMController.ts').EventFSMController
}
