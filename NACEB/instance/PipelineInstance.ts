/**
 * NACEB Pipeline layer — PipelineInstance.
 *
 * PipelineHandler is stateless; next() is called with `this` bound to the PipelineInstance so
 * handler-authored state lives on the instance, not the handler. final lives here, not on the task.
 */

import { uid } from '../../utils/id.ts'
import { PIPELINE_TRANSITIONS, cap, TERMINAL } from '../types.ts'
import type { PipelineStatus, PipelineStep, PipelineHandler, NormalSignal, TaskSignal, HookFn, TransitionFunc } from '../types.ts'
import type { PipelineFSMController } from '../controller/PipelineFSMController.ts'
import type { TaskInstance } from './TaskInstance.ts'
import type { EventInstance } from './EventInstance.ts'

/**
 * PipelineInstance — the `this` of PipelineHandler.next() (symmetric with TaskInstance: handler is stateless,
 * state lands on the instance; final lives here, not on the task). Fields in three tiers; authors touch only the third:
 *
 *   identity/input (runtime-frozen, writes throw TypeError)
 *     id        this instance id
 *     event     the EventInstance this pipeline serves (eventId: this.event.id)
 *     handler   the PipelineHandler running this instance
 *   framework state (writable, but authors must NOT touch)
 *     status / result / currentTaskId — rewritten every beat. Writing status bypasses _transition and desyncs
 *     the state machine from hooks/bus; writing result.final forges a terminal.
 *   user state (the only place authors should write)
 *     state    any key/value, survives across steps. Reference frozen (no this.state = {}), contents free
 *              (this.state.hits = 0). Destroyed with the instance; the framework neither reads nor clears it.
 */
export class PipelineInstance {
  readonly id!: string
  readonly event!: EventInstance
  readonly handler: PipelineHandler
  /** Author's per-event state space. Reference frozen, contents writable — cross-step state goes here. */
  readonly state!: Record<string, any>
  status: PipelineStatus = 'pending'
  result: { final?: unknown; process?: unknown } = {}
  currentTaskId: string | null = null
  private operation = Promise.resolve()

  private hooks = new Map<string, HookFn<PipelineInstance>[]>()
  private ctrl: PipelineFSMController

  constructor(ctrl: PipelineFSMController, event: EventInstance, handler: PipelineHandler) {
    this.ctrl = ctrl; this.handler = handler
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', uid('pipe')); ro('event', event); ro('state', {})
  }
  getTask(): TaskInstance | null { return this.currentTaskId ? this.ctrl.ref.taskController.get(this.currentTaskId) : null }
  async signalTask(signal: TaskSignal): Promise<void> { await this.getTask()?.onSignal(signal) }
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const current = this.operation.then(fn)
    this.operation = current.then(() => undefined, () => undefined)
    return current
  }
  async _onNormalSIG(signal: NormalSignal): Promise<void> {
    await this.exclusive(() => this.handler.onNormalSIG?.call(this, signal))
  }

  consume(): unknown {
    const final = this.result.final
    this.ctrl.removeByEventId(this.event.id)
    return final
  }

  private on(name: string, fn: HookFn<PipelineInstance>) { (this.hooks.get(name) ?? this.hooks.set(name, []).get(name)!).push(fn); return this }
  beforeTRunning(fn: HookFn<PipelineInstance>) { return this.on('beforeTRunning', fn) }
  afterTRunning(fn: HookFn<PipelineInstance>) { return this.on('afterTRunning', fn) }
  beforeTPaused(fn: HookFn<PipelineInstance>) { return this.on('beforeTPaused', fn) }
  afterTPaused(fn: HookFn<PipelineInstance>) { return this.on('afterTPaused', fn) }
  beforeTDone(fn: HookFn<PipelineInstance>) { return this.on('beforeTDone', fn) }
  afterTDone(fn: HookFn<PipelineInstance>) { return this.on('afterTDone', fn) }
  beforeTFailure(fn: HookFn<PipelineInstance>) { return this.on('beforeTFailure', fn) }
  afterTFailure(fn: HookFn<PipelineInstance>) { return this.on('afterTFailure', fn) }
  beforeTPending(fn: HookFn<PipelineInstance>) { return this.on('beforeTPending', fn) }
  afterTPending(fn: HookFn<PipelineInstance>) { return this.on('afterTPending', fn) }

  /**
   * Transition primitive, the only beforeT-hook entry. Log always fires (incl. same-state); the status
   * assignment is skipped when same. The pipeline has NO veto point — done/failure/paused are forced by the
   * lower task's terminal state, running is automatic flow. Any beforeT throw (incl. VetoT) is a hook bug:
   * emit error → delete beforeTFailure if target was failure → recursive _transition('failure') → false.
   */
  async _transition(to: PipelineStatus, funcs?: TransitionFunc[]): Promise<boolean> {
    const same = this.status === to
    if (!same && to !== 'failure' && !PIPELINE_TRANSITIONS[this.status].includes(to))
      throw new Error(`Pipeline invalid transition: ${this.status} → ${to} (event=${this.event.id})`)
    const c = cap(to)
    try {
      await this.ctrl.ref.THookHandler('pipeline', to, 'before', this.id, this, this.hooks.get(`beforeT${c}`))
    } catch (err) {
      // No veto point → any throw is a hook bug: layer-failure crash chain.
      const msg = (err as any)?.message ?? String(err)
      this.ctrl.ref.emit('error', this.id, { layer: 'pipeline', id: this.id, msg: `beforeT${c} hook threw (pipeline 无 veto 点) → pipeline failure: ${msg}`, opt: { eventId: this.event.id, at: `beforeT${c}`, error: msg } })
      if (to === 'failure') this.hooks.delete('beforeTFailure')
      await this._transition('failure', [() => { this.result.final = { error: msg }; this.currentTaskId = null }])
      return false
    }
    if (funcs) for (const fn of funcs) await fn()
    this.ctrl.ref.emit('log', this.id, { layer: 'pipeline', id: this.id, msg: `${this.event.id} ${this.status} → ${to}${same ? ' (same)' : ''}`, opt: { eventId: this.event.id, from: this.status, to, same } })
    if (!same) this.status = to
    await this.ctrl.ref.THookHandler('pipeline', to, 'after', this.id, this, this.hooks.get(`afterT${c}`))
    return true
  }

  async _dispatch(step: PipelineStep | undefined) {
    if (!step) { await this._transition('failure', [() => { this.result.final = { error: 'pipeline returned nothing' } }]); return }
    // Dispatch happens inside the transition; beforeTRunning does not support veto — to gate a step, veto at
    // the task layer's beforeTRunning (staying pending is naturally retryable there).
    await this._transition('running', [() => {
      const t = this.ctrl.ref.taskController.dispatch(this, step)
      this.currentTaskId = t.id
    }])
  }
  async _next(lastResult: unknown) {
    // Any throw here is an ordinary failure: this layer goes failure, bubbled up by the event's consume.
    await this.exclusive(async () => {
      try { await this._dispatch(this.handler.next.call(this, lastResult)) }
      catch (err: any) { await this._transition('failure', [() => { this.result.final = { error: err?.message ?? String(err) } }]) }
    })
  }

  /** Middle of the pause chain; false = this layer didn't reach paused → upper Event.pause rolls back. */
  async _pause(): Promise<boolean> {
    const t = this.getTask()
    if (!(await this._transition('paused'))) return false
    if (t) await t._stop()
    return true
  }
  /** Middle of the resume chain; task._restart runs first, then this layer goes running. */
  async _resume(): Promise<boolean> {
    const t = this.getTask()
    if (t) await t._restart()
    return await this._transition('running')
  }
}
