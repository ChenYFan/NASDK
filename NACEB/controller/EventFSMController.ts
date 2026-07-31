/**
 * NACEB Event layer — EventInstance + EventFSMController.
 *
 * The event is the top-level unit. It starts in idle (sentinel: no hooks, no events, perTick ignores it),
 * then flows blocked/queue → activating → processing ⇄ pending ⇄ paused → done/failure. Only the event
 * controller returns after a single action per tick (rate limit); pipeline/task run unthrottled beneath it.
 */

import type { EventStatus, EventHooks, EventInterface, NacebPrivateRef } from '../types.ts'
import type { Naceb } from '../NACEB.ts'
import type { PipelineFSMController } from './PipelineFSMController.ts'
import { EventInstance } from '../instance/EventInstance.ts'
export { EventInstance } from '../instance/EventInstance.ts'

// ============================================================
// EventFSMController
// ============================================================
export class EventFSMController {
  queue: EventInstance[] = []
  naceb: Naceb
  ref: NacebPrivateRef

  constructor(naceb: Naceb, ref: NacebPrivateRef) {
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
   *  = non-terminal, OR terminal but !bypassConsume (awaiting external consume).
   *  A terminal + bypassConsume event is not live (discard-on-terminal; perTick auto-consumes it). */
  hasLive(): boolean {
    return this.queue.some(e => {
      const terminal = e.status === 'done' || e.status === 'failure'
      return !terminal || !e.bypassConsume
    })
  }

  /** nextTick — only the event controller returns after a single action. Order 3.1→3.4, ignoring idle.
   *  错误处理全内建进 EventInstance._transition（veto→留原态、bug→forceCleanEventUnderLayer+落 failure），
   *  故这里调用点干净：`await e._transition(...)` 后直接 return true（这拍有动作，走 self 补拍/下拍重试）。 */
  async nextTick(): Promise<boolean> {
    const P = this.ref.pipelineController()
    // 3.1 processing/pending/paused: pipeline done/failure → terminal; paused is driven only by Event.pause/resume (perTick leaves it); else align by task kind.
    for (const e of this.queue) {
      if (e.status !== 'processing' && e.status !== 'pending' && e.status !== 'paused') continue
      const ps = P.getStatus(e.id)
      if (ps === 'done' || ps === 'failure') { await this._terminate(e, ps, P); return true }
      if (e.status === 'paused') continue   // paused is external will; only Event.resume leaves it, perTick does not touch it
      const kind = P.getCurrentTaskKind(e.id)
      const want: EventStatus | null = kind === 'blocked' ? 'processing' : kind === 'async' ? 'pending' : null
      if (want && want !== e.status) { await e._transition(want); return true }
    }
    // 3.2 activating: pipeline 已终局（首步 next 就抛，一个 task 都没派出）→ 直接收终局；
    //     否则抓当前 task 的类型来更新自己；pipeline 还 pending（首步未派）则不动。
    for (const e of this.queue) {
      if (e.status !== 'activating') continue
      const ps = P.getStatus(e.id)
      if (ps === 'done' || ps === 'failure') { await this._terminate(e, ps, P); return true }
      const kind = P.getCurrentTaskKind(e.id)
      if (kind === null) continue
      const want: EventStatus = kind === 'blocked' ? 'processing' : 'pending'
      await e._transition(want)
      return true
    }
    // 3.3 queue: same-scope unoccupied → transition to activating; pipeline 在 transition 的 func 里建（beforeTActivating
    //   veto → 什么都没建、event 留 queue；hook bug → _transition 内崩溃链落 failure）。都算这拍有动作 → return true。
    for (const e of this.queue) {
      if (e.status !== 'queue') continue
      if (this.isScopeBusy(e.scope, e.id)) continue
      await e._transition('activating', [() => { P.activate(e) }])
      return true
    }
    // 3.4 blocked: all blockedBy done/absent → queue.
    for (const e of this.queue) {
      if (e.status !== 'blocked') continue
      const ok = (e.blockedBy ?? []).every(id => { const s = this.getStatus(id); return s === null || s === 'done' || s === 'failure' })
      if (!ok) continue
      await e._transition('queue')
      return true
    }
    // 3.5 reclaim: terminal (done/failure) + bypassConsume events auto-consume directly (does not spend the single-action budget, clears all in one pass).
    //   afterTDone/afterTFailure already ran in 3.1's _transition (wait4 already got the child result), so clearing here is safe.
    for (const e of [...this.queue])
      if ((e.status === 'done' || e.status === 'failure') && e.bypassConsume) this.consume(e.id)
    return false
  }

  /** Terminal collapse (→ done/failure): 消费下层 pipeline（取 final + 销毁）是转移副作用，放进 _transition 的 func
   *  （beforeT{Done|Failure} 之后、改 status 之前）。错误已内建 _transition：veto → 留原态、pipeline 未消费，下拍
   *  重试；hook bug → _transition 内崩溃链（forceCleanEventUnderLayer 清下层 + 落 failure）。这拍都算有动作。 */
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
