/**
 * NACEB Event layer — EventInstance.
 * implements EventInterface: the instance IS the event data, not a wrapper around it.
 */

import { EVENT_TRANSITIONS, cap, isBlocked, BUILTIN_NAMES } from '../types.ts'
import type { EventStatus, EventInterface, EventHooks, NormalSignal, HookFn, TransitionFunc } from '../types.ts'
import type { EventFSMController } from '../controller/EventFSMController.ts'
import type { PipelineInstance } from './PipelineInstance.ts'
import { VetoT } from '../errors.ts'

export class EventInstance implements EventInterface {
  // ---- EventInterface fields (runtime-frozen via defineProperty) ----
  readonly id!: string
  name!: string
  pipelineName!: string
  payload!: unknown
  scope?: string
  blockedBy?: string[]
  parentId?: string

  // ---- runtime fields ----
  readonly bypassConsume: boolean
  status: EventStatus = 'idle'
  final?: unknown

  private hooks = new Map<string, HookFn<EventInstance>[]>()
  private ctrl: EventFSMController

  constructor(ctrl: EventFSMController, event: EventInterface, opts?: { hooks?: EventHooks; bypassConsume?: boolean }) {
    this.ctrl = ctrl
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', event.id)
    this.name = event.name; this.pipelineName = event.pipelineName; this.payload = event.payload
    this.scope = event.scope; this.blockedBy = event.blockedBy; this.parentId = event.parentId
    this.bypassConsume = !!opts?.bypassConsume
    const hooks = opts?.hooks
    if (hooks) for (const [name, fn] of Object.entries(hooks)) if (fn) this.on(name, fn as HookFn<EventInstance>)
  }

  getPipeline(): PipelineInstance | null { return this.ctrl.ref.pipelineController().getByEventId(this.id) }
  consume(): unknown { return this.ctrl.consume(this.id) }

  private on(name: string, fn: HookFn<EventInstance>) { (this.hooks.get(name) ?? this.hooks.set(name, []).get(name)!).push(fn); return this }
  beforeTBlocked(fn: HookFn<EventInstance>) { return this.on('beforeTBlocked', fn) }
  afterTBlocked(fn: HookFn<EventInstance>) { return this.on('afterTBlocked', fn) }
  beforeTQueue(fn: HookFn<EventInstance>) { return this.on('beforeTQueue', fn) }
  afterTQueue(fn: HookFn<EventInstance>) { return this.on('afterTQueue', fn) }
  beforeTActivating(fn: HookFn<EventInstance>) { return this.on('beforeTActivating', fn) }
  afterTActivating(fn: HookFn<EventInstance>) { return this.on('afterTActivating', fn) }
  beforeTProcessing(fn: HookFn<EventInstance>) { return this.on('beforeTProcessing', fn) }
  afterTProcessing(fn: HookFn<EventInstance>) { return this.on('afterTProcessing', fn) }
  beforeTPending(fn: HookFn<EventInstance>) { return this.on('beforeTPending', fn) }
  afterTPending(fn: HookFn<EventInstance>) { return this.on('afterTPending', fn) }
  beforeTPaused(fn: HookFn<EventInstance>) { return this.on('beforeTPaused', fn) }
  afterTPaused(fn: HookFn<EventInstance>) { return this.on('afterTPaused', fn) }
  beforeTDone(fn: HookFn<EventInstance>) { return this.on('beforeTDone', fn) }
  afterTDone(fn: HookFn<EventInstance>) { return this.on('afterTDone', fn) }
  beforeTFailure(fn: HookFn<EventInstance>) { return this.on('beforeTFailure', fn) }
  afterTFailure(fn: HookFn<EventInstance>) { return this.on('afterTFailure', fn) }

  /**
   * Transition primitive, the only beforeT-hook entry. Returns boolean: transitioned=true; veto-left
   * (or hook-bug crash)=false, which chain commands (pause/resume) read; nextTick/start ignore it.
   * Order: beforeT hook → funcs → status → afterT hook. If beforeT throws:
   *   - VetoT non-terminal (blocked/queue/activating/processing/pending/paused) → warning + stay + false (has a
   *     convergence condition: hook mutated blockedBy/scope/task-type, next beat re-decides).
   *   - VetoT terminal (done/failure) → NOT vetoable (already fact): warn + proceed anyway — a terminal veto would
   *     re-read the same terminal pipeline next beat and "virtual moved" self-re-fire → 0-delay deadlock + live orphan.
   *   - Any other throw (hook bug) → event crash-chain: forceCleanEventUnderLayer (tick doesn't sync down, so a
   *     crashed event leaves live child task/pipeline orphans) → if original target was failure delete beforeTFailure
   *     (break recursion) → recursive _transition('failure') → false.
   */
  async _transition(to: EventStatus, funcs?: TransitionFunc[]): Promise<boolean> {
    const same = this.status === to
    if (!same && to !== 'failure' && !EVENT_TRANSITIONS[this.status].includes(to))
      throw new Error(`Event invalid transition: ${this.status} → ${to} (${this.id})`)
    const c = cap(to)
    try {
      await this.ctrl.ref.THookHandler('event', to, 'before', this.id, this, this.hooks.get(`beforeT${c}`))
    } catch (err) {
      if (err instanceof VetoT) {
        // Terminal (done/failure) is not vetoable: already fact, no convergence condition — a veto would spin empty
        // and leave the pipeline a live orphan. Downgrade to warning and proceed (fall through to funcs/status/afterT).
        const terminal = to === 'done' || to === 'failure'
        this.ctrl.ref.emit('warning', this.id, {
          layer: 'event', id: this.id,
          msg: terminal
            ? `beforeT${c} vetoed but ${to} is terminal (not vetoable) → proceeding: ${err.message}`
            : `beforeT${c} vetoed → stay ${this.status}: ${err.message}`,
          opt: { reason: terminal ? `beforeT${c}-veto-ignored-terminal` : `beforeT${c}-vetoed`, veto: err.message },
        })
        if (!terminal) return false   // non-terminal: stay, retried next beat
      } else {
        // hook bug → crash chain: force-clean live lower orphans → delete beforeTFailure (if crashing toward failure) → recurse to event failure → false
        const msg = (err as any)?.message ?? String(err)
        this.ctrl.ref.emit('error', this.id, { layer: 'event', id: this.id, msg: `beforeT${c} hook threw (not VetoT) → forceCleanEventUnderLayer + event failure: ${msg}`, opt: { at: `beforeT${c}`, error: msg } })
        await this.ctrl.ref.forceCleanEventUnderLayer(this.id)
        if (to === 'failure') this.hooks.delete('beforeTFailure')
        await this._transition('failure', [() => { this.final = { error: `beforeT${c} hook threw: ${msg}` } }])
        return false
      }
    }
    if (funcs) for (const fn of funcs) await fn()
    if (!same) { this.ctrl.ref.emit('log', this.id, { layer: 'event', id: this.id, msg: `${this.id} ${this.status} → ${to}`, opt: { from: this.status, to } }); this.status = to }
    await this.ctrl.ref.THookHandler('event', to, 'after', this.id, this, this.hooks.get(`afterT${c}`))
    return true
  }

  async start(): Promise<void> {
    if (this.status !== 'idle') return
    // idle→blocked/queue is the only transition driven externally (not nextTick). Error handling lives in
    // _transition (veto→stay idle, warn, retry by re-start; bug→inside forceCleanEventUnderLayer + failure).
    // ensureClock is required: idle doesn't hold the clock (hasLive excludes it), so a queue of only idle
    // stops the table — a bare alertTick would run one beat and stall.
    await this._transition(isBlocked(this.blockedBy ?? []) ? 'blocked' : 'queue')
    this.ctrl.ref.ensureClock()
    this.ctrl.ref.alertTick('start')
  }

  /** External command: pause. Top-down: mark self, then await the layer below (event paused →
   *  pipeline._pause → task._stop). pause/resume are external will, not nextTick, no re-fire retry.
   *  The chain is all-or-nothing: if the event didn't reach paused (veto'd or crashed) don't push down; if the
   *  pipeline didn't stop (its beforeTPaused hook crashed to failure) roll back to processing/pending (or follow
   *  the pipeline's terminal) — never leave "event paused but pipeline failed" (that would let pause() lie and
   *  strand a paused event a tick-exempt state nobody recovers). Builtin $ tasks cannot be paused. */
  async pause(): Promise<boolean> {
    const p = this.getPipeline()
    const t = p?.getTask()
    if (t && BUILTIN_NAMES.includes(t.name))
      throw new Error(`event ${this.id} is running builtin ${t.name}, cannot pause (forbidden during terminal/spawn/await-child)`)
    if (!(await this._transition('paused'))) {   // event didn't reach paused → don't push down
      this.ctrl.ref.emit('warning', this.id, { layer: 'event', id: this.id, msg: `pause 未推进（event 未转 paused：被 veto 或已崩 failure），可重新推进`, opt: { op: 'pause' } })
      return false
    }
    if (p && !(await p._pause())) {   // layer below didn't stop → roll back, no skew
      // Rollback target can't come from getCurrentTaskKind: the pipeline's crash chain already cleared
      // currentTaskId, so the kind is always null. If the pipeline is terminal, follow it (step 1 would have done
      // this next beat — do it now so the event isn't stuck in paused, a tick-exempt state); else return to
      // processing/pending per the current task kind.
      const ps = p.status
      if (ps === 'done' || ps === 'failure') await this._transition(ps, [() => { this.final = p.consume() }])
      else {
        const kind = this.ctrl.ref.pipelineController().getCurrentTaskKind(this.id)
        await this._transition(kind === 'blocked' ? 'processing' : 'pending')
      }
      this.ctrl.ref.emit('warning', this.id, { layer: 'event', id: this.id, msg: `pause 失败并已回滚（pipeline 未转 paused），event 不停留在 paused`, opt: { op: 'pause', reason: 'pipeline-pause-failed' } })
      return false
    }
    return true
  }

  /** External command: resume. Top-down: await the layer below first, then align self (pipeline._resume →
   *  task._restart → event realigns to the task kind). If the pipeline didn't reach running, leave self paused
   *  (symmetric to pause, no cross-layer skew). Reads _transition's bool; veto/bug are absorbed there. After the
   *  event realigns, ensureClock + alertTick: paused doesn't hold the clock, so it may have stopped — without a
   *  restart nothing drives the event back to processing/pending. */
  async resume(): Promise<boolean> {
    const p = this.getPipeline()
    if (p && !(await p._resume())) {   // layer below didn't resume → stay paused
      this.ctrl.ref.emit('warning', this.id, { layer: 'event', id: this.id, msg: `resume 未推进（pipeline 未转 running），event 留在 paused，可重新推进`, opt: { op: 'resume', reason: 'pipeline-resume-failed' } })
      return false
    }
    const kind = this.ctrl.ref.pipelineController().getCurrentTaskKind(this.id)
    const ok = kind === 'blocked' ? await this._transition('processing')
      : kind === 'async' ? await this._transition('pending')
        : true   // kind === null：无当前 task，无需对齐
    if (!ok) this.ctrl.ref.emit('warning', this.id, { layer: 'event', id: this.id, msg: `resume 未完成 event 对齐（被 veto 或已崩 failure），可重新推进`, opt: { op: 'resume' } })
    else { this.ctrl.ref.ensureClock(); this.ctrl.ref.alertTick('resume') }
    return ok
  }

  async normalSIG(signal: NormalSignal): Promise<void> {
    const p = this.getPipeline()
    if (!p) throw new Error(`event ${this.id} has no active pipeline`)
    await this.ctrl.ref.pipelineController().normalSIG(p, signal)
  }

  async abort(): Promise<void> {
    if (this.status === 'done' || this.status === 'failure') throw new Error(`event ${this.id} has ended`)
    await this.ctrl.ref.forceCleanEventUnderLayer(this.id)
    await this._transition('failure', [() => { this.final = { error: 'aborted' } }])
  }
}
