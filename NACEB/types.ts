// State machines (failure is an absolute sink: any state may enter, none may leave):
//   Event    : idle → blocked/queue → activating → processing ⇄ pending ⇄ paused → done/failure
//   Pipeline : pending → running ⇄ paused → done/failure
//   Task     : pending → running → done/stopped/failure ; stopped → pending (restart)

import type { EventInstance } from './controller/EventFSMController.ts'
// Shared with NACAB, hence defined at the NASDK root.
import type { RuntimeLevelAll, RuntimePayload, RuntimeEmitFor } from '../types.ts'
// Only the handler's schema is invoked; zod is not imported at runtime.
import type { ZodType } from 'zod'

export type EventStatus =
  | 'idle' | 'blocked' | 'queue' | 'activating' | 'processing' | 'pending' | 'paused' | 'done' | 'failure'
export type PipelineStatus = 'pending' | 'running' | 'paused' | 'done' | 'failure'
export type TaskStatus = 'pending' | 'running' | 'done' | 'stopped' | 'failure'

// busyKeys present ⟹ blocked, absent ⟹ async.
export abstract class TaskHandler<R = unknown> {
  abstract readonly name: string
  readonly busyKeys?: string[]
  readonly payloadSchema?: ZodType
  abstract execute(this: any): Promise<R>
  onSignal?(this: any, signal: TaskSignal): void | Promise<void>
}

export interface NormalSignal { signalId: string; kind: 'normal'; payload: unknown }
export type TaskSignal = NormalSignal | { kind: 'abort' }

export class TaskResponse {
  readonly result: unknown
  constructor(result: unknown) { this.result = result }
}

// The whole $ namespace is reserved; users cannot register into it.
export const TERMINAL = '$terminal'
export const FIRE4SUBEVENT = '$fire4SubEvent'
export const WAIT4SUBEVENT = '$wait4SubEvent'
export const BUILTIN_NAMES = [TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT]

export interface SubEventSpec {
  pipelineName: string
  payload: unknown
}

export interface NACEBRef {
  pushEvent(e: Omit<EventInterface, 'id' | 'name' | 'pipelineName'> & { id?: string; name?: string; pipelineName?: string }, opts?: PushOpts): string
  getEvent(id: string): EventInstance | null
  consumeEvent(id: string): unknown
}

export interface PipelineStep {
  task: string
  input: unknown
}

export abstract class PipelineHandler {
  abstract readonly name: string
  readonly description?: string
  abstract next(this: any, lastResult: unknown): PipelineStep | undefined
  onNormalSIG?(this: any, signal: NormalSignal): void | Promise<void>
}

// id/name/pipelineName may be omitted at push time; pushEvent fills them in.
export interface EventInterface {
  readonly id: string
  name: string
  pipelineName: string     // resolved at push: alias.pipelineName overrides; else must be self-carried
  payload: unknown
  scope?: string
  blockedBy?: string[]     // prerequisites: other events' ids
  parentId?: string        // runtime-stamped by builtin $fire4/$wait4SubEvent
}

export interface NACEBRef {
  pushEvent(e: Omit<EventInterface, 'id' | 'name' | 'pipelineName'> & { id?: string; name?: string; pipelineName?: string }, opts?: PushOpts): string
  getEvent(id: string): EventInstance | null
  consumeEvent(id: string): unknown
}

export interface EventAlias {
  eventName: string
  pipelineName: string
  description: string
}

export type { Event } from '../types.ts'

export interface PushOpts {
  hooks?: EventHooks
  bypassIdle?: boolean
  bypassConsume?: boolean
}

export interface NACEBHooks {
  beforePushEvent?(e: EventInterface): void | { reject?: true }
  afterPushEvent?(e: EventInterface): void
}

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

export type HookFn<T> = (this: T) => void | Promise<void>
export const isBlocked = (b: string[]) => b.length > 0
export const cap = <S extends string>(s: S) => (s[0].toUpperCase() + s.slice(1)) as Capitalize<S>

// Side-effect run inside `_transition`, between the before-hook (veto point) and the status
// change — lower-layer objects get built here, so a veto aborts before anything exists.
export type TransitionFunc = () => void | Promise<void>

// message level: formal process output from a running task; id = the eventId.
export type RuntimeLevel = RuntimeLevelAll
export type { RuntimePayload }
export type RuntimeEmit = RuntimeEmitFor<RuntimeLevel>

export type THookHandler = (layer: string, state: string, phase: string, id: string, obj: any, hooks?: HookFn<any>[]) => Promise<void>

// Private capabilities injected to the three Controllers; private members always go through
// this.ref. Cross-references resolve their construction cycle with lazy getters.
export interface NACEBPrivateRef {
  THookHandler: THookHandler
  emit: RuntimeEmit
  emitMessage: (t: any, chunk: unknown) => void
  alertTick: (from: string) => void
  // Idempotent; start()/resume() must call it when leaving a tick-exempt state.
  ensureClock: () => void
  forceCleanEventUnderLayer: (eventId: string) => Promise<void>
  taskController: import('./controller/TaskFSMController.ts').TaskFSMController
  pipelineController: () => import('./controller/PipelineFSMController.ts').PipelineFSMController
  eventController: () => import('./controller/EventFSMController.ts').EventFSMController
}
