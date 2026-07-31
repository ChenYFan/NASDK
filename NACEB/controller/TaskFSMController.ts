/**
 * NACEB Task layer — TaskInstance + the three builtin $ handlers + TaskFSMController.
 *
 * TaskFSMController holds two lanes and doubles as the runner:
 *   - blockedQueue: one busyKey → lane; within a lane, serial (one running at a time).
 *   - asyncQueue:   flat, unbounded concurrency.
 * A handler with busyKeys is blocked; without, async. This is the async/blocked split.
 */

import {
  TaskHandler, TaskResponse, TASK_TRANSITIONS, cap, isBlocked,
  TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT, BUILTIN_NAMES,
} from '../types.ts'
import type { TaskStatus, PipelineStep, SubEventSpec, NacebRef, HookFn, NacebPrivateRef } from '../types.ts'
import type { Naceb } from '../NACEB.ts'
import { TaskInstance } from '../instance/TaskInstance.ts'
export { TaskInstance } from '../instance/TaskInstance.ts'
import type { PipelineInstance } from '../instance/PipelineInstance.ts'

// ============================================================
// builtin privileged handlers
// ============================================================
// 三个内建 handler 的 execute 与用户 handler 同构：`this` = TaskInstance，唯一入参 = 上游 PipelineInstance。
// naceb 能力（pushEvent/getEvent/consumeEvent）靠**闭包**捕获 ref 取得——不能挂在 handler 实例上
// （因为 this 已经绑到 TaskInstance，读不到 handler 自己的字段）。这层特权只有内建 handler 有。

function makeTerminalHandler(): TaskHandler {
  return new class extends TaskHandler<unknown> {
    readonly name = TERMINAL
    async execute(this: TaskInstance): Promise<unknown> { return this.input }
  }()
}

function makeFire4SubEventHandler(ref: NacebRef): TaskHandler {
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

function makeWait4SubEventHandler(ref: NacebRef): TaskHandler {
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

// ============================================================
// TaskFSMController
// ============================================================
export class TaskFSMController {
  private builtins = new Map<string, TaskHandler>()
  blockedQueue = new Map<string, TaskInstance[]>()
  asyncQueue: TaskInstance[] = []
  protected byId = new Map<string, TaskInstance>()
  stopTimeoutMs = 120000   // _stop 里 abort 后最多等 task 内任务回调收尾的时长（120s）；超时视为收尾（execute Promise 后台自生自灭）。影响 pause 与 forceCleanEventUnderLayer 清理。
  naceb: Naceb
  ref: NacebPrivateRef

  constructor(naceb: Naceb, ref: NacebPrivateRef) {
    this.naceb = naceb; this.ref = ref
  }

  /** 查 handler：先内部 builtins（$ task），再走 naceb 的 public taskHandlers 注册表。 */
  _getHandler(name: string): TaskHandler | undefined {
    return this.builtins.get(name) ?? this.naceb.taskHandlers.get(name)
  }

  /** 查询该 event 的所有 task（运行时通常 0-1 个，因 pipeline 单 currentTask）。forceCleanEventUnderLayer 用它列出待清理的 task。 */
  findTaskByEventId(eventId: string): TaskInstance[] {
    return [...this.byId.values()].filter(t => t.eventId === eventId)
  }

  /** Assembly-only: register a builtin $ handler (bypasses the reserved-name check). */
  registerBuiltin(h: TaskHandler) { this.builtins.set(h.name, h) }

  dispatch(pipeline: PipelineInstance, step: PipelineStep): TaskInstance {
    const h = this._getHandler(step.task); if (!h) throw new Error(`unknown task '${step.task}'`)
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

  /** ignite：把 pending task 转 running 后 _run。错误处理已全内建进 TaskInstance._transition（beforeTRunning
   *  是 task 唯一可 veto 点：veto → 留 pending、返回 false；hook bug → 内部落本层 failure、返回 false）。这里只读
   *  bool：转成 running（true）才 _run；否则不 _run（veto 留 pending 下拍重试 / bug 已 failure）。都算这拍有动作。 */
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

export function builtinHandlers(ref: NacebRef): TaskHandler[] {
  return [makeTerminalHandler(), makeFire4SubEventHandler(ref), makeWait4SubEventHandler(ref)]
}
