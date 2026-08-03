/**
 * NACEB Event layer — EventInstance.
 * implements EventInterface: the instance IS the event data, not a wrapper around it.
 */

import { EVENT_TRANSITIONS, cap, isBlocked, BUILTIN_NAMES } from '../types.ts'
import type { EventStatus, EventInterface, EventHooks, HookFn, TransitionFunc } from '../types.ts'
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
   * 转移原语，也是 beforeT hook 的唯一入口，故错误处理内建于此（线性、无 helper）。
   * **返回 boolean：转成了目标 to = true；没转成（veto 留原态 / bug 崩溃收尾）= false。** 关心「到底转没转」
   * 的链式外部命令（pause/resume）读这个 bool 决定要不要走下一步；nextTick/start 不看（veto 靠下拍重试、bug 已自收尾）。
   * 顺序：beforeT hook → funcs → 改 status → afterT hook。跑完 beforeT 若抛出：
   *   - VetoT 且 **to 非终局**（blocked/queue/activating/processing/pending/paused）→ emit warning，return false
   *     （留原态，不跑 funcs/status/afterT）。这些点可 veto 是因为它们都有**收敛条件**：hook 改了 blockedBy /
   *     scope / task 类型，下拍 controller 重新判据就会放行或改道。
   *   - VetoT 但 **to 是终局（done/failure）**→ **不可否决**，降级为 warning 后**照常放行**。理由与 task 层
   *     一致（既成事实）：pipeline 已经终局，没有任何可篡改的条件能让它「不再是终局」，veto 只会让下拍第 1 步
   *     再读到同一个终局 pipeline 再被 veto ——而 veto 走「虚拟 moved」出口会 setTimeout(0) 立刻补拍，形成 0 延迟
   *     死循环，且 pipeline 永不被消费（活孤儿）。故终局 veto 必须无效。
   *   - 其它任何 throw（hook bug）→ **event 特有崩溃链**：forceCleanEventUnderLayer 强清下层活孤儿（tick 不从
   *     上往下同步，event 崩了 task/pipeline 是活孤儿）→ 若原转移本就往 failure 则删本层 beforeTFailure（破递归）
   *     → 递归 `_transition('failure')` 落 event 终局 → return false（原 to 未达成）。
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
        // 终局（done/failure）不可否决：既成事实、无收敛条件，veto 只会死循环空转且把 pipeline 挂成活孤儿。
        // → 降级 warning 后**跳出 catch 照常放行**（走下面的 funcs/status/afterT）。
        const terminal = to === 'done' || to === 'failure'
        this.ctrl.ref.emit('warning', this.id, {
          layer: 'event', id: this.id,
          msg: terminal
            ? `beforeT${c} vetoed but ${to} is terminal (not vetoable) → proceeding: ${err.message}`
            : `beforeT${c} vetoed → stay ${this.status}: ${err.message}`,
          opt: { reason: terminal ? `beforeT${c}-veto-ignored-terminal` : `beforeT${c}-vetoed`, veto: err.message },
        })
        if (!terminal) return false   // 非终局：留原态、下拍重试
      } else {
        // hook bug → 崩溃链：强清下层活孤儿 → 删 beforeTFailure（若崩在往 failure）→ 递归落 event failure → return false
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
    // idle→blocked/queue 是唯一由外部 start 驱动（非 nextTick）的转移。错误处理已全部内建进 _transition：
    // veto → 留 idle（emit warning，外部想重试就再 start()）；hook bug → _transition 内 forceCleanEventUnderLayer
    // + 落 failure。start 只管触发转移 + 拉起时钟 + alertTick。
    // ensureClock 必须调：idle 不撑时钟（hasLive 排除），队列只剩 idle 时表是停的，光发 alertTick 只跑一刻就断。
    await this._transition(isBlocked(this.blockedBy ?? []) ? 'blocked' : 'queue')
    this.ctrl.ref.ensureClock()
    this.ctrl.ref.alertTick('start')
  }

  /** 外部命令：暂停。自顶向下、先标记自己再 await 下层（event paused → pipeline._pause → task._stop）。
   *  pause/resume 是外部意志、不在 nextTick、无补拍重试。错误处理已内建进 _transition：veto→留原态、bug→崩溃链。
   *  **整条链是全有或全无**：event 没转成 paused（被 veto 或已崩 failure）就不推下层；下层没停成（pipeline
   *  的 beforeTPaused hook bug 落了 failure）则**把自己转回去**——绝不留下「event 停在 paused 但 pipeline 已
   *  failure」的层间错位（那会让 pause() 谎报成功，且 paused 本该是 tick 豁免态、没人替它收终局）。
   *  builtin $ task 运行中禁止 pause（硬拒绝，抛错）。 */
  async pause(): Promise<boolean> {
    const p = this.getPipeline()
    const t = p?.getTask()
    if (t && BUILTIN_NAMES.includes(t.name))
      throw new Error(`event ${this.id} is running builtin ${t.name}, cannot pause (forbidden during terminal/spawn/await-child)`)
    if (!(await this._transition('paused'))) {   // event 没转成 paused → 不推下层
      this.ctrl.ref.emit('warning', this.id, { layer: 'event', id: this.id, msg: `pause 未推进（event 未转 paused：被 veto 或已崩 failure），可重新推进`, opt: { op: 'pause' } })
      return false
    }
    if (p && !(await p._pause())) {   // 下层没停成 → 回滚自己，不留错位
      // 回滚目标不能靠 getCurrentTaskKind 推：pipeline 的崩溃链已把 currentTaskId 清空，kind 恒为 null。
      // pipeline 已终局 → 直接跟着收终局（下拍第 1 步本会做，这里提前落定，免得 event 卡在 paused 这个 tick 豁免态）；
      // 未终局 → 按当前 task 类型回到 processing/pending。
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

  /** 外部命令：恢复。自顶向下、先 await 下层再更新自己（pipeline._resume → task._restart → event 按 task 类型对齐）。
   *  下层没恢复成（pipeline 未转 running）则**不动自己**、留在 paused，外部可重新推进——与 pause 对称，不留层间错位。
   *  event 的对齐转移读 _transition 的 bool；veto/bug 已在 _transition 内消化，这里只在没转成时 emit warning。返回
   *  bool（转成了目标态 = true，veto/bug 留原态 = false）。
   *  转成后必须 ensureClock + alertTick：paused 不撑时钟（hasLive 排除），暂停期间表可能已停，
   *  不重启则 event 转回 processing/pending 后没有任何来源再推进它。 */
  async resume(): Promise<boolean> {
    const p = this.getPipeline()
    if (p && !(await p._resume())) {   // 下层没恢复成 → 自己留在 paused
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
}
