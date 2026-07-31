/**
 * NACEB Pipeline layer — PipelineInstance + PipelineFSMController.
 *
 * PipelineHandler is stateless; next() is called with `this` bound to the PipelineInstance so
 * handler-authored state (e.g. this.hits) lives on the instance, not the handler.
 * final lives here, not on the task.
 */

import { PIPELINE_TRANSITIONS, cap, TERMINAL } from '../types.ts'
import type { PipelineStatus, PipelineStep, PipelineHandler, HookFn, NacebPrivateRef } from '../types.ts'
import type { Naceb } from '../NACEB.ts'
import type { TaskFSMController, TaskInstance } from './TaskFSMController.ts'
import type { EventInstance } from '../instance/EventInstance.ts'
import { PipelineInstance } from '../instance/PipelineInstance.ts'
export { PipelineInstance } from '../instance/PipelineInstance.ts'

// ============================================================
// PipelineFSMController
// ============================================================
export class PipelineFSMController {
  queue: PipelineInstance[] = []
  naceb: Naceb
  ref: NacebPrivateRef

  constructor(naceb: Naceb, ref: NacebPrivateRef) {
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
  /** 入参是 eventId（pipeline 按 event 单射，一个 event 至多一条 pipeline）。 */
  getStatus(eventId: string) { return this.getByEventId(eventId)?.status ?? null }
  removeByEventId(eventId: string) { const i = this.queue.findIndex(p => p.event.id === eventId); if (i >= 0) this.queue.splice(i, 1) }

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
        // TERMINAL done → pipeline done（既成回收，_transition 内建终局保护兜 hook 抛出）。非 TERMINAL → 派下一个 task。
        if (t.name === TERMINAL) await p._transition('done', [() => { p.result.final = result }])
        else await p._next(result)
      } else if (t.status === 'stopped') {
        await p._transition('paused')
      } else {
        // task failure → pipeline failure（既成回收）：consume 掉 task（取 {error}）+ 写 final，_transition 内建保护兜 hook 抛出。
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
