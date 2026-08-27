/**
 * NACEB Event layer — EventInstance + EventFSMController.
 *
 * The event is the top-level unit. It starts in idle (sentinel: no hooks, no events, perTick ignores it),
 * then flows blocked/queue → activating → processing ⇄ pending ⇄ paused → done/failure. Only the event
 * controller returns after a single action per tick (rate limit); pipeline/task run unthrottled beneath it.
 */

import type { EventStatus, EventHooks, EventInterface, NACEBPrivateRef } from '../types.ts'
import type { NACEB } from '../NACEB.ts'
import type { PipelineFSMController } from './PipelineFSMController.ts'
import { EventInstance } from '../instance/EventInstance.ts'
export { EventInstance } from '../instance/EventInstance.ts'

// ============================================================
// EventFSMController
// ============================================================
export class EventFSMController {
  queue: EventInstance[] = []
  naceb: NACEB
  ref: NACEBPrivateRef

  constructor(naceb: NACEB, ref: NACEBPrivateRef) {
    this.naceb = naceb; this.ref = ref
  }

  /** push: build an EventInstance (idle). opts.hooks attached, opts.bypassConsume recorded; returns the object so the caller can attach more hooks / start. */
  push(event: EventInterface, opts?: { hooks?: EventHooks; bypassConsume?: boolean }): EventInstance {
    const e = new EventInstance(this, event, opts)
    this.queue.push(e)
    this.ref.emit('log', event.id, { layer: 'event', id: event.id, msg: `${event.id} → idle` })
    return e
  }
  getById(id: string): EventInstance | null { return this.queue.find(e => e.id === id) ?? null }
  getStatus(id: string): EventStatus | null { return this.getById(id)?.status ?? null }

  /** consume: take the terminal result and return it, removing on take. Only done/failure is consumable (non-terminal throws, guards against clearing a running event, P0-5). */
  consume(id: string): unknown {
    const e = this.getById(id); if (!e) throw new Error(`consumeEvent: no such event ${id}`)
    if (e.status !== 'done' && e.status !== 'failure')
      throw new Error(`consumeEvent: event ${id} is ${e.status} (non-terminal), not consumable`)
    const final = e.final
    const i = this.queue.indexOf(e); if (i >= 0) this.queue.splice(i, 1)
    this.ref.emit('log', id, { layer: 'event', id, msg: `${id} consumed (${e.status})`, opt: { status: e.status } })
    return final
  }

  /** Clock liveness: keep running while any event still needs attention —
   *  idle / paused are tick-exempt (waiting for external start() / resume(); nextTick always skips them), so they
   *  do NOT hold the clock: a queue of only idle/paused stops it, and start()/resume() re-arm it via ensureClock.
   *  Non-terminal = live; terminal but !bypassConsume is also live (waiting for external consume).
   *  Terminal + bypassConsume is not live (discard-on-terminal; perTick auto-consumes). */
  hasLive(): boolean {
    return this.queue.some(e => {
      if (e.status === 'idle' || e.status === 'paused') return false
      const terminal = e.status === 'done' || e.status === 'failure'
      return !terminal || !e.bypassConsume
    })
  }

  /** nextTick — only the event controller returns after a single action. Order 1→4, ignoring idle/paused.
   *  Error handling is entirely inside EventInstance._transition (veto→stay, bug→forceCleanEventUnderLayer +
   *  failure), so the call sites are clean: `await e._transition(...)` then return true (this beat had an action;
   *  self re-fire / next-beat retry). Nothing here needs a fallback: pause/resume are all-or-nothing (roll back on
   *  lower-layer failure), so "event paused but pipeline terminal" never exists for the tick to repair. done/failure
   *  are reclaimed only in step 4 (bypassConsume). */
  async nextTick(): Promise<boolean> {
    const P = this.ref.pipelineController()
    // 1 processing/pending/activating: sync pipeline state to the event (terminal → take terminal; no task → skip;
    //   else align to the task kind).
    for (const e of this.queue) {
      if (e.status !== 'processing' && e.status !== 'pending' && e.status !== 'activating') continue
      const ps = P.getStatus(e.id)
      if (ps === 'done' || ps === 'failure') { await this._terminate(e, ps, P); return true }
      const kind = P.getCurrentTaskKind(e.id)
      const want: EventStatus | null = kind === 'blocked' ? 'processing' : kind === 'async' ? 'pending' : null
      if (want && want !== e.status) { await e._transition(want); return true }
    }
    // 2 queue: same-scope unoccupied → activating; the pipeline is built inside the transition func (beforeTActivating
    //   veto → nothing built, event stays queue; hook bug → crash chain to failure inside _transition). Either counts as
    //   one action → return true.
    for (const e of this.queue) {
      if (e.status !== 'queue') continue
      if (this.isScopeBusy(e.scope, e.id)) continue
      await e._transition('activating', [() => { P.activate(e) }])
      return true
    }
    // 3 blocked: all blockedBy done/failure/absent → queue.
    for (const e of this.queue) {
      if (e.status !== 'blocked') continue
      const ok = (e.blockedBy ?? []).every(id => { const s = this.getStatus(id); return s === null || s === 'done' || s === 'failure' })
      if (!ok) continue
      await e._transition('queue')
      return true
    }
    // 4 reclaim: terminal (done/failure) + bypassConsume events auto-consume directly (does not spend the single-action budget, clears all in one pass).
    //   afterTDone/afterTFailure already ran in step 1's _transition (wait4 already got the child result), so clearing here is safe.
    for (const e of [...this.queue])
      if ((e.status === 'done' || e.status === 'failure') && e.bypassConsume) this.consume(e.id)
    return false
  }

  /** Terminal collapse (→ done/failure): consuming the lower pipeline (take final + destroy) is a transition
   *  side-effect, placed in _transition's func (after beforeT{Done|Failure}, before the status change). Errors live
   *  in _transition: veto → stay, pipeline unconsumed, retried next beat; hook bug → crash chain (forceCleanEventUnderLayer
   *  + failure). This beat counts as an action either way. */
  private async _terminate(e: EventInstance, ps: 'done' | 'failure', P: PipelineFSMController): Promise<void> {
    await e._transition(ps, [() => {
      const p = P.getByEventId(e.id)
      e.final = p ? p.consume() : undefined   // take final + destroy pipeline; lands on e.final for external consumeEvent
    }])
  }

  private isScopeBusy(scope: string | undefined, selfId: string) {
    if (!scope) return false
    return this.queue.some(e => e.id !== selfId && e.scope === scope &&
      (e.status === 'activating' || e.status === 'processing' || e.status === 'pending' || e.status === 'paused'))
  }
}
