// blockedQueue: busyKey → lane, serial within a lane. asyncQueue: flat, unbounded concurrency.

import {
  TaskHandler, TaskResponse, TASK_TRANSITIONS, cap, isBlocked,
  TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT, BUILTIN_NAMES,
} from '../types.ts'
import type { TaskStatus, PipelineStep, SubEventSpec, NACEBRef, HookFn, NACEBPrivateRef } from '../types.ts'
import { nacebInternal } from '../errors.ts'
import type { NACEB } from '../NACEB.ts'
import { TaskInstance } from '../instance/TaskInstance.ts'
export { TaskInstance } from '../instance/TaskInstance.ts'
import type { PipelineInstance } from '../instance/PipelineInstance.ts'

// Builtin $ handlers: `this` = TaskInstance; NACEB capability captured via closure over ref.

function makeTerminalHandler(): TaskHandler {
  return new class extends TaskHandler<unknown> {
    readonly name = TERMINAL
    async execute(this: TaskInstance): Promise<unknown> { return this.input }
  }()
}

function makeFire4SubEventHandler(ref: NACEBRef): TaskHandler {
  return new class extends TaskHandler<{ childId: string }> {
    readonly name = FIRE4SUBEVENT
    async execute(this: TaskInstance): Promise<{ childId: string }> {
      const spec = this.input as SubEventSpec
      const childId = ref.pushEvent(
        { pipelineName: spec.pipelineName, payload: spec.payload, parentId: this.eventId },
        { bypassConsume: true },
      )
      ref.getEvent(childId)!.start()
      return { childId }
    }
  }()
}

function makeWait4SubEventHandler(ref: NACEBRef): TaskHandler {
  return new class extends TaskHandler<unknown> {
    readonly name = WAIT4SUBEVENT
    async execute(this: TaskInstance): Promise<unknown> {
      const spec = this.input as SubEventSpec
      const childId = ref.pushEvent({ pipelineName: spec.pipelineName, payload: spec.payload, parentId: this.eventId })
      const child = ref.getEvent(childId)!
      const signal = this.abortSignal
      return new Promise((resolve, reject) => {
        child.afterTDone(() => resolve(ref.consumeEvent(childId)))
        child.afterTFailure(() => reject(ref.consumeEvent(childId)))
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        child.start()
      })
    }
  }()
}

export class TaskFSMController {
  private builtins = new Map<string, TaskHandler>()
  blockedQueue = new Map<string, TaskInstance[]>()
  asyncQueue: TaskInstance[] = []
  protected byId = new Map<string, TaskInstance>()
  // After abort, wait at most this long for the execute callback to settle; past it the
  // promise is abandoned. Affects pause and forceCleanEventUnderLayer cleanup.
  stopTimeoutMs = 120000
  naceb: NACEB
  ref: NACEBPrivateRef

  constructor(naceb: NACEB, ref: NACEBPrivateRef) {
    this.naceb = naceb; this.ref = ref
  }

  _getHandler(name: string): TaskHandler | undefined {
    return this.builtins.get(name) ?? this.naceb.taskHandlers.get(name)
  }

  findTaskByEventId(eventId: string): TaskInstance[] {
    return [...this.byId.values()].filter(t => t.eventId === eventId)
  }

  registerBuiltin(h: TaskHandler) { this.builtins.set(h.name, h) }

  dispatch(pipeline: PipelineInstance, step: PipelineStep): TaskInstance {
    const h = this._getHandler(step.task); if (!h) throw new Error(`unknown task '${step.task}'`)
    // Validate before constructing; PipelineInstance turns this throw into pipeline/event failure.
    if (h.payloadSchema) {
      const r = h.payloadSchema.safeParse(step.input)
      if (!r.success) throw nacebInternal('bad-task-input', `task '${step.task}' input rejected: ${r.error.message}`)
    }
    const t = new TaskInstance(this, pipeline, step, h)
    this.byId.set(t.id, t)
    if (t.isBlocked()) for (const k of t.busyKeys) { if (!this.blockedQueue.has(k)) this.blockedQueue.set(k, []); this.blockedQueue.get(k)!.push(t) }
    else this.asyncQueue.push(t)
    return t
  }
  get(id: string) { return this.byId.get(id) ?? null }
  remove(id: string) {
    const t = this.byId.get(id); if (!t) return
    if (t.isBlocked()) for (const k of t.busyKeys) { const lane = this.blockedQueue.get(k)!; const i = lane.indexOf(t); if (i >= 0) lane.splice(i, 1) }
    else { const i = this.asyncQueue.indexOf(t); if (i >= 0) this.asyncQueue.splice(i, 1) }
    this.byId.delete(id)
  }
  private isLaneFree(k: string) { return !(this.blockedQueue.get(k) || []).some(t => t.status === 'running') }

  // beforeTRunning is the only veto point (veto → stay pending).
  private async _ignite(t: TaskInstance): Promise<boolean> {
    if (await t._transition('running')) t._run()
    return true
  }

  async nextTick(): Promise<boolean> {
    let moved = false
    for (const t of [...this.asyncQueue]) if (t.status === 'pending') { await this._ignite(t); moved = true }
    const seen = new Set<string>()
    for (const [, lane] of this.blockedQueue)
      for (const t of [...lane])
        if (t.status === 'pending' && !seen.has(t.id)
          && t.busyKeys.every(k => this.isLaneFree(k))
          && t.busyKeys.every(k => this.blockedQueue.get(k)!.find(x => x.status === 'pending') === t)) {
          seen.add(t.id); await this._ignite(t); moved = true
        }
    return moved
  }
}

export function builtinHandlers(ref: NACEBRef): TaskHandler[] {
  return [makeTerminalHandler(), makeFire4SubEventHandler(ref), makeWait4SubEventHandler(ref)]
}
