/**
 * NACEB Pipeline layer — PipelineInstance + PipelineFSMController.
 *
 * PipelineHandler is stateless; next() is called with `this` bound to the PipelineInstance so
 * handler-authored state (e.g. this.hits) lives on the instance, not the handler.
 * final lives here, not on the task.
 */

import { PIPELINE_TRANSITIONS, cap, TERMINAL } from '../types.ts'
import type { PipelineStatus, PipelineStep, PipelineHandler, NormalSignal, HookFn, NACEBPrivateRef } from '../types.ts'
import type { NACEB } from '../NACEB.ts'
import type { TaskFSMController, TaskInstance } from './TaskFSMController.ts'
import type { EventInstance } from '../instance/EventInstance.ts'
import { PipelineInstance } from '../instance/PipelineInstance.ts'
export { PipelineInstance } from '../instance/PipelineInstance.ts'

// ============================================================
// PipelineFSMController
// ============================================================
export class PipelineFSMController {
  queue: PipelineInstance[] = []
  naceb: NACEB
  ref: NACEBPrivateRef

  constructor(naceb: NACEB, ref: NACEBPrivateRef) {
    this.naceb = naceb; this.ref = ref
  }
  isRegistered(name: string) { return !!this.naceb.pipelineHandlers.get(name) }

  activate(event: EventInstance): PipelineInstance {
    const handler = this.naceb.pipelineHandlers.get(event.pipelineName); if (!handler) throw new Error(`unknown pipeline '${event.pipelineName}'`)
    const p = new PipelineInstance(this, event, handler)
    this.queue.push(p)
    return p
  }
  getByEventId(eventId: string): PipelineInstance | null { return this.queue.find(p => p.event.id === eventId) ?? null }
  /** Takes an eventId (pipeline is injective per event — an event has at most one pipeline). */
  getStatus(eventId: string) { return this.getByEventId(eventId)?.status ?? null }
  removeByEventId(eventId: string) { const i = this.queue.findIndex(p => p.event.id === eventId); if (i >= 0) this.queue.splice(i, 1) }

  async normalSIG(p: PipelineInstance, signal: NormalSignal): Promise<void> {
    await p._onNormalSIG(signal)
  }

  getCurrentTaskKind(eventId: string): 'blocked' | 'async' | null {
    const p = this.getByEventId(eventId); if (!p || !p.currentTaskId) return null
    const t = this.ref.taskController.get(p.currentTaskId)
    if (!t) return null
    return t.isBlocked() ? 'blocked' : 'async'
  }

  async nextTick(): Promise<boolean> {
    let moved = false
    for (const p of [...this.queue]) {
      if (p.status !== 'running' || !p.currentTaskId) continue
      const t = this.ref.taskController.get(p.currentTaskId); if (!t) continue
      if (t.status !== 'done' && t.status !== 'stopped' && t.status !== 'failure') continue
      if (t.status === 'done') {
        const result = t.consume(); p.currentTaskId = null
        if (t.name === TERMINAL) await p._transition('done', [() => { p.result.final = result }])
        else await p._next(result)
      } else if (t.status === 'stopped') {
        await p._transition('paused')
      } else {
        // task failure → pipeline failure: consume the task ({error}) + write final.
        await p._transition('failure', [() => { p.result.final = t.consume(); p.currentTaskId = null }])
      }
      moved = true
    }
    for (const p of [...this.queue]) {
      if (p.status !== 'pending') continue
      await p._next(undefined)
      moved = true
    }
    return moved
  }
}
