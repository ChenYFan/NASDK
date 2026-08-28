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
// Runtime observation payload + level superset live at the NASDK root: NACEB and NACAB both narrate on the
// same shape, so it is not either layer's to own.
import type { RuntimeLevelAll, RuntimePayload, RuntimeEmitFor } from '../types.ts'
// NACEB only invokes the schema supplied by the handler; it does not import zod at runtime.
import type { ZodType } from 'zod'

// ---- status ----
export type EventStatus =
  | 'idle' | 'blocked' | 'queue' | 'activating' | 'processing' | 'pending' | 'paused' | 'done' | 'failure'
export type PipelineStatus = 'pending' | 'running' | 'paused' | 'done' | 'failure'
export type TaskStatus = 'pending' | 'running' | 'done' | 'stopped' | 'failure'

// ---- public contracts ----

/**
 * TaskHandler: the only handler form. busyKeys present ⟹ blocked, absent ⟹ async.
 * Stateless, registered once; execute() runs with `this` bound to the TaskInstance (`this.input`,
 * `this.state`, `this.abortSignal`, `this.processingResultReport(chunk)`). The sole parameter is the
 * upstream PipelineInstance — cross-step state goes to `pCtx.state`.
 */
export abstract class TaskHandler<R = unknown> {
  abstract readonly name: string
  readonly busyKeys?: string[]
  /** Pure input gate: parsed output discarded. */
  readonly payloadSchema?: ZodType
  abstract execute(this: any): Promise<R>
  onSignal?(this: any, signal: TaskSignal): void | Promise<void>
}

export interface NormalSignal { signalId: string; kind: 'normal'; payload: unknown }
export type TaskSignal = NormalSignal | { kind: 'abort' }

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
 * The child neither joins the parent's occupancy contention nor inherits its prerequisites.
 */
export interface SubEventSpec {
  pipelineName: string
  payload: unknown
}

/** NACEB reference handed to builtin privileged handlers at assembly time. */
export interface NACEBRef {
  pushEvent(e: Omit<EventInterface, 'id' | 'name' | 'pipelineName'> & { id?: string; name?: string; pipelineName?: string }, opts?: PushOpts): string
  getEvent(id: string): EventInstance | null
  consumeEvent(id: string): unknown
}

export interface PipelineStep {
  task: string
  input: unknown
}

/** PipelineHandler: stateless, registered once; next() runs with `this` = PipelineInstance. */
export abstract class PipelineHandler {
  abstract readonly name: string
  readonly description?: string
  abstract next(this: any, lastResult: unknown): PipelineStep | undefined
  onNormalSIG?(this: any, signal: NormalSignal): void | Promise<void>
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

/** eventName is an alias for a pipeline plus a description; many-to-one. */
export interface EventAlias {
  eventName: string
  pipelineName: string
  description: string
}

export type { Event } from '../types.ts'

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
 * TransitionFunc — a side-effect run inside `_transition`, between the before-hook (veto point) and the
 * status change. This is where lower-layer objects get built (Event activating news the PipelineInstance,
 * Pipeline running dispatches the TaskInstance), so a veto aborts before anything exists.
 * Order: beforeT hook → funcs (in order) → status change → afterT hook. A func runs before the status change.
 */
export type TransitionFunc = () => void | Promise<void>

/**
 * Runtime observation events — `naceb:runtime:{level}:{id}`:
 *   - error / warning / log : id = the triggering layer's instance id
 *   - message               : formal process output from a running task; id = the eventId
 */
export type RuntimeLevel = RuntimeLevelAll
export type { RuntimePayload }
/** Injected by NACEB at assembly: emits `naceb:runtime:{level}:{id}` on the internal EventBus. */
export type RuntimeEmit = RuntimeEmitFor<RuntimeLevel>

/** Firing a T event = emit the T event (readonlyView over `this`) + run that state's hook list in order. */
export type THookHandler = (layer: string, state: string, phase: string, id: string, obj: any, hooks?: HookFn<any>[]) => Promise<void>

/**
 * NACEBPrivateRef — NACEB's private capabilities, injected to the three Controllers. A Controller holds
 * `.naceb` (public members) + `.ref` (this box); private members always go through this.ref. The controllers'
 * mutual cross-references also live here (construction cycle resolved with lazy getters).
 */
export interface NACEBPrivateRef {
  THookHandler: THookHandler
  emit: RuntimeEmit
  emitMessage: (t: any, chunk: unknown) => void
  alertTick: (from: string) => void
  /** Bring the 20Hz base clock up (idempotent); start()/resume() must call it when leaving an exempt state. */
  ensureClock: () => void
  forceCleanEventUnderLayer: (eventId: string) => Promise<void>
  taskController: import('./controller/TaskFSMController.ts').TaskFSMController
  pipelineController: () => import('./controller/PipelineFSMController.ts').PipelineFSMController
  eventController: () => import('./controller/EventFSMController.ts').EventFSMController
}
