/**
 * NACEB Task layer — TaskInstance.
 *
 * TaskHandler is stateless; execute() is called with `this` bound to the TaskInstance so
 * handler-authored state lands on the instance, never on the handler.
 * A task is one-shot: execute() runs once, then the instance is discarded.
 * State that must survive across steps goes to pCtx.state (PipelineInstance), not this.state.
 */

import { uid } from '../../utils/id.ts'
import { TASK_TRANSITIONS, cap, isBlocked, BUILTIN_NAMES, TaskResponse } from '../types.ts'
import type { TaskStatus, PipelineStep, TaskHandler, TaskSignal, HookFn, TransitionFunc } from '../types.ts'
import type { TaskFSMController } from '../controller/TaskFSMController.ts'
import type { PipelineInstance } from './PipelineInstance.ts'
import { VetoT } from '../errors.ts'

/**
 * TaskInstance — the `this` of TaskHandler.execute() (symmetric with PipelineInstance: handler is always
 * stateless, state lands on the instance). Fields in three tiers; authors touch only the third:
 *
 *   identity/input (runtime-frozen, writes throw TypeError)
 *     id / name / busyKeys / input    this task's identity and input
 *     pipeline                       upstream PipelineInstance (eventId: this.pipeline.event.id)
 *   framework state (writable, but authors must NOT touch)
 *     status / result / response / error / abort — the framework rewrites these every beat. Writing status
 *     bypasses _transition and desyncs the state machine from hooks/bus.
 *   user state (the only place authors should write)
 *     state    per-task scratch. ⚠️ a task is one-shot: execute runs once, the instance is then discarded,
 *              so this.state only lives for this execute. Cross-step state goes to this.pipeline.state
 *              (which survives to the event terminal).
 */
export class TaskInstance {
  readonly id!: string
  readonly pipeline!: PipelineInstance
  readonly name!: string
  readonly busyKeys!: string[]
  readonly input!: unknown
  /** This execute's state space. The reference is frozen, contents are writable. Cross-step → this.pipeline.state. */
  readonly state!: Record<string, any>
  status: TaskStatus = 'pending'
  result: { process?: unknown } = {}
  response?: TaskResponse
  error?: unknown
  abort = new AbortController()
  _donePromise: Promise<void> | null = null

  private hooks = new Map<string, HookFn<TaskInstance>[]>()
  private ctrl: TaskFSMController

  constructor(ctrl: TaskFSMController, pipeline: PipelineInstance, step: PipelineStep, handler: TaskHandler) {
    this.ctrl = ctrl
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', uid('task')); ro('pipeline', pipeline); ro('state', {})
    ro('name', handler.name); ro('busyKeys', handler.busyKeys ?? [])
    Object.defineProperty(this, 'input', { value: step.input, writable: true, enumerable: true })
  }

  get eventId(): string { return this.pipeline.event.id }
  get abortSignal(): AbortSignal { return this.abort.signal }
  processingResultReport(chunk: unknown): void {
    this.result.process = chunk
    this.ctrl.ref.emitMessage(this, chunk)
  }
  async onSignal(signal: TaskSignal): Promise<void> {
    if (signal.kind === 'abort' && !this.abort.signal.aborted) this.abort.abort('stopped')
    const handler = this.ctrl._getHandler(this.name)
    await handler?.onSignal?.call(this, signal)
  }
  isBlocked() { return isBlocked(this.busyKeys) }

  private on(name: string, fn: HookFn<TaskInstance>) { (this.hooks.get(name) ?? this.hooks.set(name, []).get(name)!).push(fn); return this }
  beforeTRunning(fn: HookFn<TaskInstance>) { return this.on('beforeTRunning', fn) }
  afterTRunning(fn: HookFn<TaskInstance>) { return this.on('afterTRunning', fn) }
  beforeTDone(fn: HookFn<TaskInstance>) { return this.on('beforeTDone', fn) }
  afterTDone(fn: HookFn<TaskInstance>) { return this.on('afterTDone', fn) }
  beforeTStopped(fn: HookFn<TaskInstance>) { return this.on('beforeTStopped', fn) }
  afterTStopped(fn: HookFn<TaskInstance>) { return this.on('afterTStopped', fn) }
  beforeTFailure(fn: HookFn<TaskInstance>) { return this.on('beforeTFailure', fn) }
  afterTFailure(fn: HookFn<TaskInstance>) { return this.on('afterTFailure', fn) }
  beforeTPending(fn: HookFn<TaskInstance>) { return this.on('beforeTPending', fn) }
  afterTPending(fn: HookFn<TaskInstance>) { return this.on('afterTPending', fn) }

  /**
   * Transition primitive, the only beforeT-hook entry. Order: beforeT hook → funcs → status → afterT hook.
   * If beforeT throws:
   *   - only `to === 'running'` can veto (stays pending, retried next beat); terminal states are facts.
   *   - any other throw → hook bug: emit error → delete beforeTFailure if target was failure (break
   *     recursion) → recursive _transition('failure') → false.
   */
  async _transition(to: TaskStatus, funcs?: TransitionFunc[]): Promise<boolean> {
    const same = this.status === to
    if (!same && to !== 'failure' && !TASK_TRANSITIONS[this.status].includes(to))
      throw new Error(`Task invalid transition: ${this.status} → ${to} (${this.id})`)
    const c = cap(to)
    try {
      await this.ctrl.ref.THookHandler('task', to, 'before', this.id, this, this.hooks.get(`beforeT${c}`))
    } catch (err) {
      if (to === 'running' && err instanceof VetoT) {   // 唯一可 veto 点 → 留 pending
        this.ctrl.ref.emit('warning', this.id, { layer: 'task', id: this.id, msg: `beforeTRunning vetoed → stay pending: ${err.message}`, opt: { reason: 'beforeTRunning-vetoed', veto: err.message } })
        return false
      }
      // hook bug → layer-failure crash chain
      const msg = (err as any)?.message ?? String(err)
      this.ctrl.ref.emit('error', this.id, { layer: 'task', id: this.id, msg: `beforeT${c} hook threw (not vetoable here) → task failure: ${msg}`, opt: { at: `beforeT${c}`, error: msg } })
      if (to === 'failure') this.hooks.delete('beforeTFailure')
      await this._transition('failure', [() => { this.error = msg }])
      return false
    }
    if (funcs) for (const fn of funcs) await fn()
    if (!same) { this.ctrl.ref.emit('log', this.id, { layer: 'task', id: this.id, msg: `${this.name}#${this.id} ${this.status} → ${to}`, opt: { name: this.name, from: this.status, to } }); this.status = to }
    await this.ctrl.ref.THookHandler('task', to, 'after', this.id, this, this.hooks.get(`afterT${c}`))
    return true
  }

  _run() {
    const handler = this.ctrl._getHandler(this.name)!
    this._donePromise = Promise.resolve()
      .then(() => handler.execute.call(this))
      .then(async (result) => {
        if (this.abort.signal.aborted) await this._transition('stopped')
        // response written as the done-transition side-effect (after beforeTDone hook).
        else await this._transition('done', [() => { this.response = new TaskResponse(result) }])
      })
      .catch(async (err) => {
        if (this.abort.signal.aborted) await this._transition('stopped')
        else await this._transition('failure', [() => { this.error = err?.message ?? String(err) }])
      })
      .finally(() => { this.ctrl.ref.alertTick('task') })
  }

  consume(): unknown {
    const result = this.status === 'done' ? this.response!.result
      : this.status === 'failure' ? { error: this.error }
        : undefined
    this.ctrl.remove(this.id)
    return result
  }

  /** force=true: the force-kill path (forceCleanEventUnderLayer) — bypasses the builtin $ task refusal; tries to
   *  stop from any state without throwing. */
  async _stop(force = false): Promise<void> {
    if (!force && BUILTIN_NAMES.includes(this.name))
      throw new Error(`Task ${this.name} is a builtin $ task and cannot be stopped.`)
    if (this.status === 'pending') { await this._transition('stopped'); this.ctrl.ref.alertTick('task'); return }
    if (this.status === 'running') {
      await this.onSignal({ kind: 'abort' })
      // Wait up to ctrl.stopTimeoutMs for the execute promise to settle; on timeout, stop waiting.
      if (this._donePromise) {
        // ⚠️ must clearTimeout: Promise.race only ignores the loser, it doesn't cancel it.
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>(res => { timer = setTimeout(() => res('timeout'), this.ctrl.stopTimeoutMs) })
        try {
          const r = await Promise.race([this._donePromise.then(() => 'done' as const), timeout])
          if (r === 'timeout')
            this.ctrl.ref.emit('error', this.eventId, { layer: 'task', id: this.eventId, msg: `task ${this.name}#${this.id} 未在 ${this.ctrl.stopTimeoutMs}ms 内响应 abort（_stop 超时）`, opt: { taskId: this.id, reason: 'stop-timeout' } })
        } finally { clearTimeout(timer) }
      }
      return
    }
    if (force) return   // force-kill: done/stopped/failure etc. need no further stop, pass silently (then consume)
    throw new Error(`Task ${this.id} in status ${this.status} cannot be stopped`)
  }
  async _restart(): Promise<void> {
    if (this.status !== 'stopped') throw new Error(`Task ${this.id} in status ${this.status} cannot restart (must be stopped)`)
    // resetting abort/response/error is the pending-transition side-effect.
    await this._transition('pending', [() => {
      this.abort = new AbortController()
      this.response = undefined; this.error = undefined
    }])
    this.ctrl.ref.alertTick('restart')
  }
}
