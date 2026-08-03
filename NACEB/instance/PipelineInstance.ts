/**
 * NACEB Pipeline layer — PipelineInstance.
 *
 * PipelineHandler is stateless; next() is called with `this` bound to the PipelineInstance so
 * handler-authored state lives on the instance, not the handler. final lives here, not on the task.
 */

import { uid } from '../../utils/id.ts'
import { PIPELINE_TRANSITIONS, cap, TERMINAL } from '../types.ts'
import type { PipelineStatus, PipelineStep, PipelineHandler, HookFn, TransitionFunc } from '../types.ts'
import type { PipelineFSMController } from '../controller/PipelineFSMController.ts'
import type { TaskInstance } from './TaskInstance.ts'
import type { EventInstance } from './EventInstance.ts'

/**
 * PipelineInstance —— PipelineHandler.next() 的 `this` 就是它。字段分三档，作者只该碰第三档：
 *
 *   身份/输入（运行时冻结，写了抛 TypeError）
 *     id      本实例 id
 *     event   本 pipeline 服务的 EventInstance（要 eventId 就取 this.event.id）
 *     handler 跑本实例的 PipelineHandler
 *   框架状态（可写，但**作者不要碰**）
 *     status / result / currentTaskId —— 框架每拍要改。写 status 会绕过 _transition 让状态机与
 *     hook/bus 失同步；写 result.final 会伪造终局。
 *   用户状态（作者唯一该写的地方）
 *     state   任意键值，跨步保存。引用冻结（不能 this.state = {…}）、内容自由读写
 *             （this.state.hits = 0 / this.state.hits++）。随实例销毁，框架不读不清。
 */
export class PipelineInstance {
  readonly id!: string
  readonly event!: EventInstance
  readonly handler: PipelineHandler
  /** 作者的 per-event 状态空间。引用冻结、内容可写——跨步要留的东西写这里。 */
  readonly state!: Record<string, any>
  status: PipelineStatus = 'pending'
  result: { final?: unknown; process?: unknown } = {}
  currentTaskId: string | null = null

  private hooks = new Map<string, HookFn<PipelineInstance>[]>()
  private ctrl: PipelineFSMController

  constructor(ctrl: PipelineFSMController, event: EventInstance, handler: PipelineHandler) {
    this.ctrl = ctrl; this.handler = handler
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', uid('pipe')); ro('event', event); ro('state', {})
  }
  getTask(): TaskInstance | null { return this.currentTaskId ? this.ctrl.ref.taskController.get(this.currentTaskId) : null }

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
   * 转移原语，也是 beforeT hook 的唯一入口，错误处理内建（线性、无 helper）。**返回 boolean：转成 = true；
   * 没转成（bug 落 failure）= false**。log 一律发（含同态：running→running 派新 task 是有效迁移）；仅「改 status 值」
   * 在同态时跳过。**pipeline 一个 veto 点都没有**：done/failure/paused 由下层 task 终态逼定（既成事实）；running
   * （派下一个 task）是 handler.next() 驱动的自动流转、不该被 hook 拦（veto 会致 next() 重放 / running→running 混乱）。
   * 故 beforeT 抛任何东西（含 VetoT）都当 hook bug：emit error → 若原转移本就往 failure 则删本层 beforeTFailure
   * （破递归）→ 递归 `_transition('failure')` 落本层 failure → return false。pipeline 层崩溃无活 task（没派 / 已
   * consume / 已终态），故只本层 failure、靠 tick 被 event consume 冒泡同步，**不 forceCleanEventUnderLayer**。
   */
  async _transition(to: PipelineStatus, funcs?: TransitionFunc[]): Promise<boolean> {
    const same = this.status === to
    if (!same && to !== 'failure' && !PIPELINE_TRANSITIONS[this.status].includes(to))
      throw new Error(`Pipeline invalid transition: ${this.status} → ${to} (event=${this.event.id})`)
    const c = cap(to)
    try {
      await this.ctrl.ref.THookHandler('pipeline', to, 'before', this.id, this, this.hooks.get(`beforeT${c}`))
    } catch (err) {
      // pipeline 无 veto 点 → 任何抛出（含 VetoT）都是 hook bug：本层 failure 崩溃链
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
    // 派 task 在 transition 内（beforeTRunning hook 之后、改 status 之前）。pipeline 的「派下一个 task」是
    // handler.next() 驱动的**自动流转**，不是用户该拦的向下转移决策点 → **beforeTRunning 不支持 veto**：
    // 抛任何东西（含 VetoT）都冒到 _next 的 catch 当普通 failure（重放 next() 会错乱、running→running 也不合
    // 状态机；要拦某步请在 task 层 beforeTRunning 拦——那里 task 新建、留 pending 天然可重试）。
    await this._transition('running', [() => {
      const t = this.ctrl.ref.taskController.dispatch(this, step)
      this.currentTaskId = t.id
    }])
  }
  async _next(lastResult: unknown) {
    // pipeline 层崩溃时下层无活 task（没派 / 已 consume / 已终态），故任何抛出（handler.next() 业务错、
    // dispatch unknown task、beforeTRunning hook bug、甚至 VetoT）都当**普通 failure**：本层转 failure，
    // 失败结果随后被 event consume、向上冒泡，本层机制自己同步状态。不 forceCleanEventUnderLayer（那只为 event 层
    // 的活孤儿 task 准备）。
    try { await this._dispatch(this.handler.next.call(this, lastResult)) }
    catch (err: any) { await this._transition('failure', [() => { this.result.final = { error: err?.message ?? String(err) } }]) }
  }

  /** 暂停链的中段。**返回 boolean：整段成功 = true；本层没转成 paused（hook bug 落 failure）= false**。
   *  返回 false 时**不动下层 task**——上层 Event.pause 读这个 bool 决定回滚，避免「Event 停在 paused 但
   *  pipeline 已 failure」的层间错位（那种错位会让 pause() 谎报成功）。 */
  async _pause(): Promise<boolean> {
    const t = this.getTask()
    if (!(await this._transition('paused'))) return false
    if (t) await t._stop()
    return true
  }
  /** 恢复链的中段。**返回 boolean：整段成功 = true；本层没转成 running = false**。
   *  task._restart 先跑（它断言自己是 stopped，不满足就抛），本层再转 running。 */
  async _resume(): Promise<boolean> {
    const t = this.getTask()
    if (t) await t._restart()
    return await this._transition('running')
  }
}
