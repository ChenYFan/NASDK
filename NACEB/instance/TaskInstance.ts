/**
 * NACEB Task layer — TaskInstance.
 *
 * TaskHandler is stateless; execute() is called with `this` bound to the TaskInstance so
 * handler-authored state lands on the instance, never on the handler.
 * A task is one-shot: execute() runs once, then the instance is discarded.
 * State that must survive across steps goes to pCtx.state (PipelineInstance), not this.state.
 */

import { uid } from '../../utils/id.ts'
import { TASK_TRANSITIONS, cap, isBlocked, BUILTIN_NAMES, TaskResponse } from '../types.ts'
import type { TaskStatus, PipelineStep, TaskHandler, HookFn, TransitionFunc } from '../types.ts'
import type { TaskFSMController } from '../controller/TaskFSMController.ts'
import type { PipelineInstance } from './PipelineInstance.ts'
import { VetoT } from '../errors.ts'

/**
 * TaskInstance —— TaskHandler.execute() 的 `this` 就是它（与 PipelineInstance 对称：Handler 恒无状态，
 * 状态一律落 Instance）。字段分三档，作者只该碰第三档：
 *
 *   身份/输入（运行时冻结，写了抛 TypeError）
 *     id / name / busyKeys / input   本 task 的身份与输入
 *     pipeline                       上游 PipelineInstance（要 eventId 取 this.pipeline.event.id，
 *                                    要 pipelineId 取 this.pipeline.id）
 *   框架状态（可写，但**作者不要碰**）
 *     status / result / response / error / abort —— 框架每拍要改。写 status 会绕过 _transition
 *     让状态机与 hook/bus 失同步。
 *   用户状态（作者唯一该写的地方）
 *     state   本 task 内的临时键值。⚠️ task 是一次性的：execute 只调一次，跑完实例即弃，
 *             所以 this.state 只在本次 execute 内有意义。要跨步留的东西写
 *             this.pipeline.state（那个活到 event 终局）。
 */
export class TaskInstance {
  readonly id!: string
  readonly pipeline!: PipelineInstance
  readonly name!: string
  readonly busyKeys!: string[]
  readonly input!: unknown
  /** 作者的本次执行状态空间。引用冻结、内容可写。跨步请改用 this.pipeline.state。 */
  readonly state!: Record<string, any>
  status: TaskStatus = 'pending'
  result: { process?: unknown } = {}
  response?: TaskResponse
  error?: unknown
  abort = new AbortController()
  _donePromise: Promise<void> | null = null

  private hooks = new Map<string, HookFn<TaskInstance>[]>()
  private ctrl: TaskFSMController

  constructor(ctrl: TaskFSMController, pipeline: PipelineInstance, step: PipelineStep, handler: TaskHandler) {
    this.ctrl = ctrl
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', uid('task')); ro('pipeline', pipeline); ro('state', {})
    ro('name', handler.name); ro('busyKeys', handler.busyKeys ?? [])
    Object.defineProperty(this, 'input', { value: step.input, writable: true, enumerable: true })
  }

  get eventId(): string { return this.pipeline.event.id }
  get abortSignal(): AbortSignal { return this.abort.signal }
  processingResultReport(chunk: unknown): void {
    this.result.process = chunk
    this.ctrl.ref.emitMessage(this, chunk)
  }
  isBlocked() { return isBlocked(this.busyKeys) }

  private on(name: string, fn: HookFn<TaskInstance>) { (this.hooks.get(name) ?? this.hooks.set(name, []).get(name)!).push(fn); return this }
  beforeTRunning(fn: HookFn<TaskInstance>) { return this.on('beforeTRunning', fn) }
  afterTRunning(fn: HookFn<TaskInstance>) { return this.on('afterTRunning', fn) }
  beforeTDone(fn: HookFn<TaskInstance>) { return this.on('beforeTDone', fn) }
  afterTDone(fn: HookFn<TaskInstance>) { return this.on('afterTDone', fn) }
  beforeTStopped(fn: HookFn<TaskInstance>) { return this.on('beforeTStopped', fn) }
  afterTStopped(fn: HookFn<TaskInstance>) { return this.on('afterTStopped', fn) }
  beforeTFailure(fn: HookFn<TaskInstance>) { return this.on('beforeTFailure', fn) }
  afterTFailure(fn: HookFn<TaskInstance>) { return this.on('afterTFailure', fn) }
  beforeTPending(fn: HookFn<TaskInstance>) { return this.on('beforeTPending', fn) }
  afterTPending(fn: HookFn<TaskInstance>) { return this.on('afterTPending', fn) }

  /**
   * 转移原语，也是 beforeT hook 的唯一入口，错误处理内建（线性、无 helper）。**返回 boolean：转成了 = true；
   * 没转成（veto 留原态 / bug 落 failure）= false**（_ignite 读这个 bool 决定要不要 _run）。
   * 顺序：beforeT hook → funcs → 改 status → afterT hook。跑完 beforeT 若抛出：
   *   - **仅 `to === 'running'` 允许 veto**（task 唯一可 veto 点，留 pending 下拍重试）：VetoT → emit warning、
   *     return false。done/failure/stopped 是既成事实（execute 已 return/throw/abort），**不存在终局 veto**。
   *   - 其它任何抛出（running 的非 VetoT bug / 终局态的任何抛出含 VetoT）→ hook bug：emit error → 若原转移本就
   *     往 failure 则删本层 beforeTFailure（破递归）→ 递归 `_transition('failure')` 落本层 failure → return false。
   *   **task 层崩溃无活副作用**（execute 已结束、或尚未 _run），故只本层 failure、靠 tick 自下而上被 pipeline
   *   consume 冒泡同步，**不 forceCleanEventUnderLayer**（那是 event 层专属：event 崩了下层才有活孤儿）。
   */
  async _transition(to: TaskStatus, funcs?: TransitionFunc[]): Promise<boolean> {
    const same = this.status === to
    if (!same && to !== 'failure' && !TASK_TRANSITIONS[this.status].includes(to))
      throw new Error(`Task invalid transition: ${this.status} → ${to} (${this.id})`)
    const c = cap(to)
    try {
      await this.ctrl.ref.THookHandler('task', to, 'before', this.id, this, this.hooks.get(`beforeT${c}`))
    } catch (err) {
      if (to === 'running' && err instanceof VetoT) {   // task 唯一可 veto 点 → 留 pending、return false
        this.ctrl.ref.emit('warning', this.id, { layer: 'task', id: this.id, msg: `beforeTRunning vetoed → stay pending: ${err.message}`, opt: { reason: 'beforeTRunning-vetoed', veto: err.message } })
        return false
      }
      // hook bug（含终局态被搅黄的任何抛出）→ 本层 failure 崩溃链
      const msg = (err as any)?.message ?? String(err)
      this.ctrl.ref.emit('error', this.id, { layer: 'task', id: this.id, msg: `beforeT${c} hook threw (not vetoable here) → task failure: ${msg}`, opt: { at: `beforeT${c}`, error: msg } })
      if (to === 'failure') this.hooks.delete('beforeTFailure')
      await this._transition('failure', [() => { this.error = msg }])
      return false
    }
    if (funcs) for (const fn of funcs) await fn()
    if (!same) { this.ctrl.ref.emit('log', this.id, { layer: 'task', id: this.id, msg: `${this.name}#${this.id} ${this.status} → ${to}`, opt: { name: this.name, from: this.status, to } }); this.status = to }
    await this.ctrl.ref.THookHandler('task', to, 'after', this.id, this, this.hooks.get(`afterT${c}`))
    return true
  }

  _run() {
    const handler = this.ctrl._getHandler(this.name)!
    this._donePromise = Promise.resolve()
      .then(() => handler.execute.call(this))
      .then(async (result) => {
        if (this.abort.signal.aborted) await this._transition('stopped')
        // writing response is the done-transition side-effect → inside _transition (after beforeTDone hook)
        else await this._transition('done', [() => { this.response = new TaskResponse(result) }])
      })
      .catch(async (err) => {
        if (this.abort.signal.aborted) await this._transition('stopped')
        else await this._transition('failure', [() => { this.error = err?.message ?? String(err) }])
      })
      .finally(() => { this.ctrl.ref.alertTick('task') })
  }

  consume(): unknown {
    const result = this.status === 'done' ? this.response!.result
      : this.status === 'failure' ? { error: this.error }
        : undefined
    this.ctrl.remove(this.id)
    return result
  }

  /** force=true：强杀路径（forceCleanEventUnderLayer）用——绕过 builtin $ task 的拒绝，任意态都尽力停下（不抛）。 */
  async _stop(force = false): Promise<void> {
    if (!force && BUILTIN_NAMES.includes(this.name))
      throw new Error(`Task ${this.name} is a builtin $ task and cannot be stopped.`)
    if (this.status === 'pending') { await this._transition('stopped'); this.ctrl.ref.alertTick('task'); return }
    if (this.status === 'running') {
      this.abort.abort('stopped')
      // 最多等 ctrl.stopTimeoutMs 收尾；超时则不再干等（execute Promise 后台自生自灭），emit 告知。
      if (this._donePromise) {
        // ⚠️ 必须 clearTimeout：Promise.race 只是忽略输的一方、不会取消它。task 正常响应 abort 时这个
        // stopTimeoutMs（默认 120s）定时器会继续挂在事件循环上，把宿主进程按住整整两分钟不退出。
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>(res => { timer = setTimeout(() => res('timeout'), this.ctrl.stopTimeoutMs) })
        try {
          const r = await Promise.race([this._donePromise.then(() => 'done' as const), timeout])
          if (r === 'timeout')
            this.ctrl.ref.emit('error', this.eventId, { layer: 'task', id: this.eventId, msg: `task ${this.name}#${this.id} 未在 ${this.ctrl.stopTimeoutMs}ms 内响应 abort（_stop 超时）`, opt: { taskId: this.id, reason: 'stop-timeout' } })
        } finally { clearTimeout(timer) }
      }
      return
    }
    if (force) return   // 强杀：done/stopped/failure 等其它态无需再停，静默放过（随后 consume）
    throw new Error(`Task ${this.id} in status ${this.status} cannot be stopped`)
  }
  async _restart(): Promise<void> {
    if (this.status !== 'stopped') throw new Error(`Task ${this.id} in status ${this.status} cannot restart (must be stopped)`)
    // resetting abort/response/error is the pending-transition side-effect (runs after beforeTPending veto passes)
    await this._transition('pending', [() => {
      this.abort = new AbortController()
      this.response = undefined; this.error = undefined
    }])
    this.ctrl.ref.alertTick('restart')
  }
}
