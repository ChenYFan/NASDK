// One action per tick (rate limit); pipeline/task run unthrottled beneath it.

import type { EventStatus, EventHooks, EventInterface, NACEBPrivateRef } from '../types.ts'
import type { NACEB } from '../NACEB.ts'
import type { PipelineFSMController } from './PipelineFSMController.ts'
import { EventInstance } from '../instance/EventInstance.ts'
export { EventInstance } from '../instance/EventInstance.ts'

export class EventFSMController {
  queue: EventInstance[] = []
  naceb: NACEB
  ref: NACEBPrivateRef

  constructor(naceb: NACEB, ref: NACEBPrivateRef) {
    this.naceb = naceb; this.ref = ref
  }

  push(event: EventInterface, opts?: { hooks?: EventHooks; bypassConsume?: boolean }): EventInstance {
    const e = new EventInstance(this, event, opts)
    this.queue.push(e)
    this.ref.emit('log', event.id, { layer: 'event', id: event.id, msg: `${event.id} → idle` })
    return e
  }
  getById(id: string): EventInstance | null { return this.queue.find(e => e.id === id) ?? null }
  getStatus(id: string): EventStatus | null { return this.getById(id)?.status ?? null }

  // Only done/failure is consumable (P0-5: guard against clearing a running event).
  consume(id: string): unknown {
    const e = this.getById(id); if (!e) throw new Error(`consumeEvent: no such event ${id}`)
    if (e.status !== 'done' && e.status !== 'failure')
      throw new Error(`consumeEvent: event ${id} is ${e.status} (non-terminal), not consumable`)
    const final = e.final
    const i = this.queue.indexOf(e); if (i >= 0) this.queue.splice(i, 1)
    this.ref.emit('log', id, { layer: 'event', id, msg: `${id} consumed (${e.status})`, opt: { status: e.status } })
    return final
  }

  // Clock liveness: terminal + !bypassConsume stays live (awaiting external consume).
  hasLive(): boolean {
    return this.queue.some(e => {
      if (e.status === 'idle' || e.status === 'paused') return false
      const terminal = e.status === 'done' || e.status === 'failure'
      return !terminal || !e.bypassConsume
    })
  }

  async nextTick(): Promise<boolean> {
    const P = this.ref.pipelineController()
    for (const e of this.queue) {
      if (e.status !== 'processing' && e.status !== 'pending' && e.status !== 'activating') continue
      const ps = P.getStatus(e.id)
      if (ps === 'done' || ps === 'failure') { await this._terminate(e, ps, P); return true }
      const kind = P.getCurrentTaskKind(e.id)
      const want: EventStatus | null = kind === 'blocked' ? 'processing' : kind === 'async' ? 'pending' : null
      if (want && want !== e.status) { await e._transition(want); return true }
    }
    // queue: same-scope unoccupied → activating.
    for (const e of this.queue) {
      if (e.status !== 'queue') continue
      if (this.isScopeBusy(e.scope, e.id)) continue
      await e._transition('activating', [() => { P.activate(e) }])
      return true
    }
    // blocked: all blockedBy done/failure/absent → queue.
    for (const e of this.queue) {
      if (e.status !== 'blocked') continue
      const ok = (e.blockedBy ?? []).every(id => { const s = this.getStatus(id); return s === null || s === 'done' || s === 'failure' })
      if (!ok) continue
      await e._transition('queue')
      return true
    }
    // reclaim: terminal + bypassConsume auto-consume (no single-action budget spent).
    for (const e of [...this.queue])
      if ((e.status === 'done' || e.status === 'failure') && e.bypassConsume) this.consume(e.id)
    return false
  }

  private async _terminate(e: EventInstance, ps: 'done' | 'failure', P: PipelineFSMController): Promise<void> {
    await e._transition(ps, [() => {
      const p = P.getByEventId(e.id)
      e.final = p ? p.consume() : undefined
    }])
  }

  private isScopeBusy(scope: string | undefined, selfId: string) {
    if (!scope) return false
    return this.queue.some(e => e.id !== selfId && e.scope === scope &&
      (e.status === 'activating' || e.status === 'processing' || e.status === 'pending' || e.status === 'paused'))
  }
}
