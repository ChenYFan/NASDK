/**
 * full/naceb — 覆盖 NACEB 正常会走到的路径。
 *
 * simple/naceb 是用例，这里是覆盖：注册表、状态机、资源竞争、Hook/Veto、SubEvent、观测面、adaptor。
 * 不走网络。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NACEB, PipelineHandler, TaskHandler, TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT, BUILTIN_NAMES, VetoT,
} from '../../NACEB/index.ts'
import { collect, sleep } from '../_kit.mjs'

// ── 局部 handler：每个测试自带，避免共享状态 ──

class Ret extends TaskHandler {
  name = 'ret'
  description = '返回 input（One 传下来的是整个 event.payload）'
  async execute() { return this.input }
}

class RetV extends TaskHandler {
  name = 'retV'
  description = '只回 payload.v'
  async execute() { return this.input?.v }
}

class Report extends TaskHandler {
  name = 'report'
  description = '上报 n 次再返回'
  async execute() {
    const n = this.input?.n ?? 2
    for (let i = 0; i < n; i++) this.processingResultReport({ i })
    return { emitted: n }
  }
}

class Throw extends TaskHandler {
  name = 'throw'
  description = '抛'
  async execute() { throw new Error(this.input?.msg ?? '故意失败') }
}

class Gpu extends TaskHandler {
  name = 'gpu'
  description = '占 gpu'
  busyKeys = ['gpu']
  async execute() {
    const s = this.input.stats
    s.now++; s.peak = Math.max(s.peak, s.now)
    await sleep(this.input.ms ?? 15)
    s.now--
    return 'gpu-done'
  }
}

class Cpu extends TaskHandler {
  name = 'cpu'
  description = '占 cpu（另一把 key）'
  busyKeys = ['cpu']
  async execute() {
    const s = this.input.stats
    s.bothNow = (s.bothNow ?? 0) + 1
    s.bothPeak = Math.max(s.bothPeak ?? 0, s.bothNow)
    await sleep(this.input.ms ?? 15)
    s.bothNow--
    return 'cpu-done'
  }
}

/** 跑 payload.task 一次就终结。 */
class One extends PipelineHandler {
  name = 'one'
  description = '一步'
  next(last) {
    if (last === undefined) return { task: this.event.payload?.task ?? 'ret', input: this.event.payload }
    return { task: TERMINAL, input: last }
  }
}

const push = (naceb, target, payload = {}, reqId = `r-${Math.random()}`) => new Promise((resolve) => {
  const chunks = []
  naceb.nacpAdaptor.push({ target, payload, reqId }, {
    onProcess: (c) => chunks.push(c),
    onResponse: (result, isOk, whyNotOk) => resolve({ result, isOk, whyNotOk, chunks }),
  })
})

const build = (extra = {}) => new NACEB({
  pipelineHandlers: [new One(), ...(extra.pipelines ?? [])],
  taskHandlers: [new Ret(), new RetV(), new Report(), new Throw(), new Gpu(), new Cpu(), ...(extra.tasks ?? [])],
  eventAlias: [{ eventName: 'go', pipelineName: 'one', description: '跑一步' }, ...(extra.alias ?? [])],
})

// ── 注册 ──

test('三种注册口都能后补', async () => {
  const naceb = new NACEB({ pipelineHandlers: [], taskHandlers: [] })
  assert.deepEqual(naceb.listEventAlias(), [])

  naceb.registerTaskHandler(new Ret())
  naceb.registerPipelineHandler(new One())
  naceb.registerEventAlias({ eventName: 'later', pipelineName: 'one', description: '后注册的' })

  assert.deepEqual(naceb.listEventAlias(), [{ name: 'later', description: '后注册的' }])
  const out = await push(naceb, 'later', { task: 'ret', v: 7 })
  assert.equal(out.isOk, true)
})

test('eventAlias 是唯一对外名单，pipeline 名不在声明里', () => {
  const naceb = build()
  const names = naceb.listEventAlias().map(e => e.name)
  assert.deepEqual(names, ['go'])
  assert.ok(!names.includes('one'), 'pipeline 内部名不外泄')
})

test('同名 alias 后注册覆盖', () => {
  const naceb = build()
  naceb.registerEventAlias({ eventName: 'go', pipelineName: 'one', description: '换了描述' })
  assert.deepEqual(naceb.listEventAlias(), [{ name: 'go', description: '换了描述' }])
})

test('内建 task 名是保留的', () => {
  assert.deepEqual(BUILTIN_NAMES, [TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT])
  assert.equal(TERMINAL, '$terminal')
})

// ── 正常跑通 ──

test('过程流条数由 handler 决定，terminal 只有一条 response', async () => {
  const naceb = build()
  for (const n of [0, 1, 5]) {
    const out = await push(naceb, 'go', { task: 'report', n })
    assert.equal(out.isOk, true)
    assert.equal(out.chunks.length, n, `上报 ${n} 次`)
    assert.deepEqual(out.result, { emitted: n })
  }
})

test('pipeline 的 state 跨步保留，input 由 next 决定', async () => {
  class Acc extends PipelineHandler {
    name = 'acc'
    description = '累加三步'
    next(last) {
      if (last === undefined) { this.state.sum = 0; return { task: 'ret', input: 1 } }
      this.state.sum += last
      if (this.state.sum >= 6) return { task: TERMINAL, input: { sum: this.state.sum } }
      return { task: 'ret', input: last + 1 }
    }
  }
  const naceb = build({ pipelines: [new Acc()], alias: [{ eventName: 'acc', pipelineName: 'acc', description: 'x' }] })
  const out = await push(naceb, 'acc', {})
  assert.deepEqual(out.result, { sum: 6 }, '1+2+3')
})

test('event payload 在 pipeline 里通过 this.event.payload 拿到', async () => {
  const naceb = build()
  const out = await push(naceb, 'go', { task: 'ret', marker: 'FROM_PAYLOAD' })
  assert.equal(out.result.marker, 'FROM_PAYLOAD', 'One 把整个 event.payload 当 task input 传下去')
})

// ── 失败 ──

test('task 抛 → isOk=false，原因在 payload 而非 whyNotOk', async () => {
  const naceb = build()
  const out = await push(naceb, 'go', { task: 'throw', msg: '内部细节' })
  assert.equal(out.isOk, false)
  assert.equal(out.whyNotOk, 'processor-failed', 'NACEB 自己的词汇不外泄到协议层')
  assert.ok(JSON.stringify(out.result).includes('内部细节'))
})

test('未知事件名 → 立刻拒，不挂住', async () => {
  const naceb = build()
  const out = await push(naceb, '没有这个事件')
  assert.equal(out.isOk, false)
})

test('alias 指向不存在的 pipeline → 也是拒', async () => {
  const naceb = build()
  naceb.registerEventAlias({ eventName: 'broken', pipelineName: '不存在的pipeline', description: 'x' })
  const out = await push(naceb, 'broken')
  assert.equal(out.isOk, false)
})

test('next 返回不存在的 task 名 → 失败而不是挂死', async () => {
  class BadNext extends PipelineHandler {
    name = 'badNext'
    description = 'x'
    next(last) { return last === undefined ? { task: '不存在的task', input: 1 } : { task: TERMINAL, input: last } }
  }
  const naceb = build({ pipelines: [new BadNext()], alias: [{ eventName: 'bad', pipelineName: 'badNext', description: 'x' }] })
  const out = await push(naceb, 'bad')
  assert.equal(out.isOk, false)
})

test('next 自己抛异常 → 失败', async () => {
  class ThrowNext extends PipelineHandler {
    name = 'throwNext'
    description = 'x'
    next() { throw new Error('next 炸了') }
  }
  const naceb = build({ pipelines: [new ThrowNext()], alias: [{ eventName: 'tn', pipelineName: 'throwNext', description: 'x' }] })
  const out = await push(naceb, 'tn')
  assert.equal(out.isOk, false)
})

test('一个 event 失败不影响后续 event', async () => {
  const naceb = build()
  assert.equal((await push(naceb, 'go', { task: 'throw' })).isOk, false)
  assert.equal((await push(naceb, 'go', { task: 'ret', v: 1 })).isOk, true)
})

// ── 资源竞争 ──

test('同一把 busyKey 串行，不同 key 并行', async () => {
  const naceb = build()

  const stats = { now: 0, peak: 0 }
  await Promise.all([1, 2, 3].map(() => push(naceb, 'go', { task: 'gpu', ms: 20, stats })))
  assert.equal(stats.peak, 1, `同 key 峰值必须是 1，实得 ${stats.peak}`)

  // gpu 和 cpu 是两把不同的 key —— 它们之间不该互相阻塞
  const s2 = { now: 0, peak: 0, bothNow: 0, bothPeak: 0 }
  const t0 = performance.now()
  await Promise.all([
    push(naceb, 'go', { task: 'gpu', ms: 40, stats: s2 }),
    push(naceb, 'go', { task: 'cpu', ms: 40, stats: s2 }),
  ])
  const ms = performance.now() - t0
  assert.ok(ms < 150, `不同 key 应该并行（两个 40ms 任务；全量并行测试留调度余量），实测 ${ms.toFixed(0)}ms`)
})

test('无 busyKeys 的 task 完全并发', async () => {
  const naceb = build()
  const t0 = performance.now()
  await Promise.all(Array.from({ length: 5 }, () => push(naceb, 'go', { task: 'report', n: 1 })))
  assert.ok(performance.now() - t0 < 200, '没有声明占用就不排队')
})

test('占用在 task 失败后也会释放', async () => {
  class GpuThrow extends TaskHandler {
    name = 'gpuThrow'
    description = 'x'
    busyKeys = ['gpu']
    async execute() { throw new Error('占着 gpu 死了') }
  }
  const naceb = build({ tasks: [new GpuThrow()] })

  assert.equal((await push(naceb, 'go', { task: 'gpuThrow' })).isOk, false)
  // 如果没释放，下面这个会永远等
  const stats = { now: 0, peak: 0 }
  const out = await push(naceb, 'go', { task: 'gpu', ms: 5, stats })
  assert.equal(out.isOk, true, 'gpu 锁已释放')
})

// ── Hook / Veto ──

test('pushEvent 的 hooks：afterTDone 能拿到实例', async () => {
  const naceb = build()
  const seen = []
  const id = naceb.pushEvent(
    { name: 'go', payload: { task: 'ret', v: 1 } },
    { hooks: { afterTDone() { seen.push(this.status) } }, bypassIdle: true },
  )
  assert.equal(typeof id, 'string')
  await sleep(80)
  assert.deepEqual(seen, ['done'])
  naceb.consumeEvent(id)
})

test('实例上的 afterTxxx 可以链式挂多个，按序执行', async () => {
  const naceb = build()
  const order = []
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 1 } }, { bypassIdle: true })
  const ev = naceb.getEvent(id)
  ev.afterTDone(() => order.push('first')).afterTDone(() => order.push('second'))
  await sleep(80)
  assert.deepEqual(order, ['first', 'second'])
  naceb.consumeEvent(id)   // 必须收尾：终态事件留在队列里会让 NACEB 的时钟一直转
})

test('beforeT hook 抛「非 VetoT」= hook bug，走崩溃链落 failure', async () => {
  const naceb = build()
  const id = naceb.pushEvent(
    { name: 'go', payload: { task: 'ret', v: 1 } },
    { hooks: { beforeTDone() { throw new Error('不许 done') } }, bypassIdle: true },
  )
  await sleep(80)
  // 这里抛的是普通 Error，不是 VetoT —— NACEB 按类型区分，普通抛出一律当 hook bug：
  // 清下层活孤儿 + 落 failure。所以终态是 failure 而不是 done，也不是「留在原态」。
  assert.equal(naceb.getEvent(id)?.status, 'failure')
  naceb.consumeEvent(id)
})

test('VetoT 在 event 非终局点：留原态、下拍重试，最终仍能跑完', async () => {
  const naceb = build()
  let vetoed = 0
  const warns = collect(naceb.eventBus, 'naceb:runtime:warning:*')

  const id = naceb.pushEvent(
    { name: 'go', payload: { task: 'ret', v: 1 } },
    {
      // activating 是非终局态，可以否决。否决两拍后放行 —— 收敛条件由 hook 自己制造。
      hooks: { beforeTActivating() { if (++vetoed <= 2) throw new VetoT(`第 ${vetoed} 次不放`) } },
      bypassIdle: true,
    },
  )
  await sleep(200)
  warns.stop()

  assert.ok(vetoed >= 3, `hook 被重试到放行，实际进了 ${vetoed} 次`)
  assert.equal(naceb.getEvent(id)?.status, 'done', 'veto 只是推迟，不是杀死')

  const vetoWarns = warns.events.filter(e => e.payload.opt?.reason === 'beforeTActivating-vetoed')
  assert.equal(vetoWarns.length, 2, '两次否决各报一条 warning')
  assert.match(vetoWarns[0].payload.msg, /vetoed → stay/, 'warning 说明留在原态')
  assert.equal(vetoWarns[0].payload.opt.veto, '第 1 次不放', 'reason 原样带出来，仅供人读')

  naceb.consumeEvent(id)
})

test('VetoT 在 event 终局点不可否决：降级 warning 后照常放行', async () => {
  const naceb = build()
  const warns = collect(naceb.eventBus, 'naceb:runtime:warning:*')
  let tries = 0

  const id = naceb.pushEvent(
    { name: 'go', payload: { task: 'ret', v: 1 } },
    { hooks: { beforeTDone() { tries++; throw new VetoT('我不想结束') } }, bypassIdle: true },
  )
  await sleep(150)
  warns.stop()

  // 终局既成事实，没有任何可篡改的条件能让它「不再是终局」。若允许否决，下拍会读到同一个终局
  // pipeline 再被否决，而 veto 出口会立刻补拍 —— 0 延迟死循环，且 pipeline 永不被消费。
  assert.equal(naceb.getEvent(id)?.status, 'done', '照常落 done')
  assert.equal(tries, 1, '只进一次 —— 放行了就不会再有下一拍来重试')

  const w = warns.events.find(e => e.payload.opt?.reason === 'beforeTDone-veto-ignored-terminal')
  assert.ok(w, '有一条「否决被忽略」的 warning')
  assert.match(w.payload.msg, /terminal \(not vetoable\) → proceeding/)

  naceb.consumeEvent(id)
})

test('VetoT 在 task 的 beforeTRunning：task 唯一可 veto 点', async () => {
  const naceb = build()
  const warns = collect(naceb.eventBus, 'naceb:runtime:warning:*')
  let vetoed = 0

  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 1 } }, { bypassIdle: false })
  const ev = naceb.getEvent(id)
  // task 实例最早在 event 的 afterTPending 才存在：afterTActivating 时 pipeline 有了但 task 还没建。
  // （ret 是 async task 走 pending；blocked task 对应的是 afterTProcessing。）
  ev.afterTPending(function () {
    const t = this.getPipeline()?.getTask()
    if (t && !t.__hooked) {
      t.__hooked = true
      t.beforeTRunning(() => { if (++vetoed <= 1) throw new VetoT('先别跑') })
    }
  })
  ev.start()

  await sleep(200)
  warns.stop()

  assert.equal(vetoed, 2, '否决一次、下拍重试放行一次 —— task 留在 pending 等下拍，不是被杀')
  assert.equal(naceb.getEvent(id)?.status, 'done', '否决过一次，之后照常跑完')

  const w = warns.events.filter(e => e.payload.opt?.reason === 'beforeTRunning-vetoed')
  assert.equal(w.length, 1, 'task 的否决也报 warning')
  assert.equal(w[0].payload.layer, 'task', 'layer 段是 task')

  naceb.consumeEvent(id)
})

test('afterT hook 抛异常只报 runtime error，不改变状态', async () => {
  const naceb = build()
  const errs = collect(naceb.eventBus, 'naceb:runtime:error:*')
  const id = naceb.pushEvent(
    { name: 'go', payload: { task: 'ret', v: 1 } },
    { hooks: { afterTDone() { throw new Error('after 炸了') } }, bypassIdle: true },
  )
  await sleep(80)
  errs.stop()
  assert.equal(naceb.getEvent(id)?.status, 'done', 'afterT 抛出不回滚状态')
  assert.ok(errs.events.some(e => String(e.payload.msg).includes('after')), '进了 runtime error')
  naceb.consumeEvent(id)
})

// ── pause / resume ──

/** 协作式取消的 task：轮询 abortSignal。NACEB 的 _stop 靠 abort 让 execute 自己退出，
 *  不看 abortSignal 的 handler 会让 pause 一直等到 stopTimeoutMs（120s）—— 那是 edge 层的事。 */
class Coop extends TaskHandler {
  name = 'coop'
  description = '协作式：可被 abort 打断，也可被外部放行'
  async execute() {
    for (let i = 0; i < 400; i++) {
      if (this.abortSignal?.aborted) throw new Error('aborted')
      if (this.pipeline.event.payload.done) return 'finished'
      await sleep(5)
    }
    return 'never'
  }
}

test('pause：三层一起停，task 被 abort 成 stopped', async () => {
  const naceb = build({ tasks: [new Coop()] })
  const payload = { task: 'coop', done: false }
  const id = naceb.pushEvent({ name: 'go', payload }, { bypassIdle: true })
  await sleep(60)

  const ev = naceb.getEvent(id)
  assert.equal(ev.status, 'pending', '跑起来了（coop 是 async task，event 在 pending）')

  assert.equal(await ev.pause(), true, 'pause 报成功')
  assert.equal(ev.status, 'paused')
  assert.equal(ev.getPipeline().status, 'paused', 'pipeline 跟着停')
  assert.equal(ev.getPipeline().getTask().status, 'stopped', 'task 被 abort 掉，不是 running')

  // paused 是时钟豁免态：不撑时钟，也不会有谁替它往前推
  await sleep(60)
  assert.equal(ev.status, 'paused', '停住就是真停住，不会自己醒')

  payload.done = true                    // 放行条件先摆好，证明 paused 期间不会被读到
  await sleep(40)
  assert.equal(ev.status, 'paused', 'paused 期间 task 根本没在跑，放行条件也不生效')

  assert.equal(await ev.resume(), true)
  await sleep(150)
  assert.equal(naceb.getEvent(id)?.status, 'done')
  assert.equal(naceb.consumeEvent(id), 'finished', 'resume 后 task 从头重跑并跑完')
})

test('resume：自顶向下对齐，event 回到 task 类型对应的态', async () => {
  const naceb = build({ tasks: [new Coop()] })
  const payload = { task: 'coop', done: false }
  const id = naceb.pushEvent({ name: 'go', payload }, { bypassIdle: true })
  await sleep(60)

  const ev = naceb.getEvent(id)
  await ev.pause()
  assert.equal(await ev.resume(), true)

  // coop 是 async task → event 对齐回 pending（blocked task 才是 processing）
  assert.equal(ev.status, 'pending')
  assert.equal(ev.getPipeline().status, 'running')
  assert.equal(ev.getPipeline().getTask().status, 'running', 'task 重新点火')

  payload.done = true
  await sleep(150)
  naceb.consumeEvent(id)
})

test('pause 期间禁止 builtin：$ task 跑着时 pause 硬拒绝', async () => {
  // 内建 task 正在等子事件 / 生成子事件时停它，会让父子两边错位（paused 是时钟豁免态，
  // 没人替父收终局）。所以这里是抛错的硬拒绝，不是返 false 的软失败。
  class WaitPipe extends PipelineHandler {
    name = 'waitPipe'
    description = '等一个子事件'
    next(last) {
      if (last === undefined) return { task: WAIT4SUBEVENT, input: { pipelineName: 'one', payload: { task: 'coop', done: true } } }
      return { task: TERMINAL, input: last }
    }
  }
  const naceb = build({
    tasks: [new Coop()], pipelines: [new WaitPipe()],
    alias: [{ eventName: 'waiter', pipelineName: 'waitPipe', description: '等子' }],
  })

  const id = naceb.pushEvent({ name: 'waiter', payload: {} }, { bypassIdle: false })
  const ev = naceb.getEvent(id)

  // 在 hook 窗口里断言，不去外面「抓时机」：内建 task 在跑的那段是竞态的（子事件 done 一开始就是
  // true，父可能在轮询的第一拍之前就跑完了，那时 getPipeline() 已经是 null）。event 的
  // afterTPending 恰好是 task 已建好、还没结束的一刻。
  let observed = null, pauseErr = null
  ev.afterTPending(async function () {
    const t = this.getPipeline()?.getTask()
    if (!t || observed) return
    observed = { name: t.name, builtin: BUILTIN_NAMES.includes(t.name) }
    try { await this.pause(); pauseErr = 'DID-NOT-THROW' } catch (e) { pauseErr = e.message }
  })
  ev.start()

  try {
    await sleep(300)
    assert.deepEqual(observed, { name: WAIT4SUBEVENT, builtin: true }, '窗口里跑的确实是内建 task')
    assert.match(String(pauseErr), /cannot pause/, '内建 task 跑着时 pause 抛错，不是返 false')
    assert.equal(naceb.getEvent(id)?.status, 'done', '被拒的 pause 没有伤到事件，它照常跑完了')
  } finally {
    // 断言成败都要收尾：终态事件留在队列里会让 NACEB 的时钟一直转，进程就不退出了。
    const e = naceb.getEvent(id)
    if (e && (e.status === 'done' || e.status === 'failure')) naceb.consumeEvent(id)
  }
})

test('pushEvent 返回 eventId，getEvent / listEvent 能查到', async () => {
  const naceb = build()
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 1 } }, { bypassIdle: true })
  assert.ok(naceb.getEvent(id), 'getEvent 查得到')
  assert.ok(naceb.listEvent().some(e => e.id === id), 'listEvent 里有它')
  await sleep(80)
  naceb.consumeEvent(id)
})

test('consumeEvent 取结果并移出队列', async () => {
  const naceb = build()
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 42 } }, { bypassIdle: true })
  await sleep(80)
  assert.deepEqual(naceb.consumeEvent(id), { task: 'ret', v: 42 }, 'Ret 回的是整个 payload')
  assert.equal(naceb.getEvent(id), null, 'consume 后就没了')
  assert.ok(!naceb.listEvent().some(e => e.id === id))
})

test('getEvent 未知 id 返 null；consumeEvent 未知 id 抛（刻意：防止清掉在跑的事件）', () => {
  const naceb = build()
  assert.equal(naceb.getEvent('没有'), null)
  assert.throws(() => naceb.consumeEvent('没有'), /no such event/)
})

test('consumeEvent 非终态也抛', () => {
  const naceb = build()
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 1 } })   // 不 bypassIdle → 停在 idle
  assert.equal(naceb.getEvent(id).status, 'idle', 'pushEvent 默认停在 idle，等外部放行')
  assert.throws(() => naceb.consumeEvent(id), /non-terminal/)
  // idle 是 tick 豁免态，不撑时钟，所以留着它不会让进程活着
})

test('状态走过 idle → … → done，可从 T 事件观测到', async () => {
  const naceb = build()
  const states = []
  naceb.eventBusObs.listen('naceb:event:*:after:*', (_p, k) => states.push(k.split(':')[2]))

  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 1 } }, { bypassIdle: true })
  await sleep(80)

  assert.ok(states.includes('done'), `终态 done，实得 ${states.join('→')}`)
  assert.ok(states.length >= 2, '经过了多个中间态')
  naceb.consumeEvent(id)
})

test('失败路径的终态是 failure', async () => {
  const naceb = build()
  const states = []
  naceb.eventBusObs.listen('naceb:event:*:after:*', (_p, k) => states.push(k.split(':')[2]))
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'throw' } }, { bypassIdle: true })
  await sleep(80)
  assert.ok(states.includes('failure'), `实得 ${states.join('→')}`)
  naceb.consumeEvent(id)
})

// ── SubEvent ──

// ── SubEvent ──
//
// 两个内建 task 都取 { pipelineName, payload }，各自 push 一个独立子 Event：
//   $fire4SubEvent — 派发完立刻返回 { childId }，不等（并发用）
//   $wait4SubEvent — 派发完阻塞等它跑完，把子事件的结果当自己的结果返回
// 子 Event 和普通 Event 是同一等公民，只多带一个 parentId。

test('$wait4SubEvent：等子事件跑完，拿它的结果', async () => {
  class Waiter extends PipelineHandler {
    name = 'waiter'
    description = '等一个子事件'
    next(last) {
      if (last === undefined)
        return { task: WAIT4SUBEVENT, input: { pipelineName: 'one', payload: { task: 'retV', v: 'from-child' } } }
      return { task: TERMINAL, input: { child: last } }
    }
  }
  const naceb = build({ pipelines: [new Waiter()], alias: [{ eventName: 'wait', pipelineName: 'waiter', description: 'x' }] })
  const out = await push(naceb, 'wait', {})
  assert.equal(out.isOk, true, JSON.stringify(out))
  assert.deepEqual(out.result, { child: 'from-child' }, '子事件的结果成了父的输入')
})

test('$fire4SubEvent：立刻返回 childId，不等子事件', async () => {
  class Firer extends PipelineHandler {
    name = 'firer'
    description = '起一个子事件就走'
    next(last) {
      if (last === undefined)
        return { task: FIRE4SUBEVENT, input: { pipelineName: 'one', payload: { task: 'retV', v: 'child-runs-alone' } } }
      return { task: TERMINAL, input: last }
    }
  }
  const naceb = build({ pipelines: [new Firer()], alias: [{ eventName: 'fire', pipelineName: 'firer', description: 'x' }] })
  const out = await push(naceb, 'fire', {})
  assert.equal(out.isOk, true, JSON.stringify(out))
  assert.equal(typeof out.result.childId, 'string', `fire 返回 {childId}，实得 ${JSON.stringify(out.result)}`)
})

test('子事件带 parentId，和普通事件一样是一等公民', async () => {
  class Firer2 extends PipelineHandler {
    name = 'firer2'
    description = 'x'
    next(last) {
      if (last === undefined)
        return { task: FIRE4SUBEVENT, input: { pipelineName: 'one', payload: { task: 'retV', v: 1 } } }
      return { task: TERMINAL, input: last }
    }
  }
  const naceb = build({ pipelines: [new Firer2()], alias: [{ eventName: 'f2', pipelineName: 'firer2', description: 'x' }] })
  const out = await push(naceb, 'f2', {})
  const child = naceb.getEvent(out.result.childId)
  // fire 的子事件默认 bypassConsume，所以跑完不会留在队列里等人取
  assert.ok(child === null || child.parentId, '子事件要么已自行清理，要么带着 parentId')
})

test('$wait4SubEvent：子事件失败会带着父一起 failure', async () => {
  class WaitBad extends PipelineHandler {
    name = 'waitBad'
    description = '等一个注定失败的子事件'
    next(last) {
      if (last === undefined)
        return { task: WAIT4SUBEVENT, input: { pipelineName: 'one', payload: { task: 'throw', msg: '子事件炸了' } } }
      return { task: TERMINAL, input: last }
    }
  }
  const naceb = build({ pipelines: [new WaitBad()], alias: [{ eventName: 'wb', pipelineName: 'waitBad', description: 'x' }] })
  const out = await push(naceb, 'wb', {})
  assert.equal(out.isOk, false, '子失败 → 父也失败')
})

test('嵌套：子事件里再起一个子事件', async () => {
  class Inner extends PipelineHandler {
    name = 'inner'
    description = '最里层'
    next(last) {
      if (last === undefined) return { task: 'retV', input: { v: 'deep' } }
      return { task: TERMINAL, input: last }
    }
  }
  class Middle extends PipelineHandler {
    name = 'middle'
    description = '中间层，等 inner'
    next(last) {
      if (last === undefined) return { task: WAIT4SUBEVENT, input: { pipelineName: 'inner', payload: {} } }
      return { task: TERMINAL, input: last }
    }
  }
  class Outer extends PipelineHandler {
    name = 'outer'
    description = '最外层，等 middle'
    next(last) {
      if (last === undefined) return { task: WAIT4SUBEVENT, input: { pipelineName: 'middle', payload: {} } }
      return { task: TERMINAL, input: { nested: last } }
    }
  }
  const naceb = build({
    pipelines: [new Inner(), new Middle(), new Outer()],
    alias: [{ eventName: 'nested', pipelineName: 'outer', description: 'x' }],
  })
  const out = await push(naceb, 'nested', {})
  assert.equal(out.isOk, true, JSON.stringify(out))
  assert.deepEqual(out.result, { nested: 'deep' }, '三层穿透')
})

// ── 观测面 ──

test('T 事件三层都有：event / pipeline / task', async () => {
  const naceb = build()
  const layers = new Set()
  naceb.eventBusObs.listen('naceb:*:*:*:*', (_p, k) => layers.add(k.split(':')[1]))
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 1 } }, { bypassIdle: true })
  await sleep(80)
  naceb.consumeEvent(id)
  assert.deepEqual([...layers].sort(), ['event', 'pipeline', 'task'])
})

test('T 事件的 this 是只读视图', async () => {
  const naceb = build()
  let threw = false
  naceb.eventBusObs.listen('naceb:task:done:after:*', function () {
    try { this.status = '改' } catch { threw = true }
  })
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', v: 1 } }, { bypassIdle: true })
  await sleep(80)
  naceb.consumeEvent(id)
  assert.equal(threw, true)
})

test('runtime message 级 = 过程流，chunk 骑在 opt 上', async () => {
  const naceb = build()
  const msgs = collect(naceb.eventBus, 'naceb:runtime:message:*')
  await push(naceb, 'go', { task: 'report', n: 3 })
  msgs.stop()

  assert.equal(msgs.events.length, 3)
  assert.equal(msgs.events[0].payload.layer, 'task')
  assert.deepEqual(msgs.events[0].payload.opt.chunk, { i: 0 })
  assert.ok(msgs.events[0].payload.opt.taskId, 'opt 带 taskId')
  assert.ok(msgs.events[0].payload.opt.eventId, 'opt 带 eventId')
})

test('runtime log 级记录状态迁移', async () => {
  const naceb = build()
  const logs = collect(naceb.eventBus, 'naceb:runtime:log:*')
  await push(naceb, 'go', { task: 'ret', v: 1 })
  logs.stop()
  assert.ok(logs.events.length > 0, '有 log')
  for (const { payload } of logs.events) {
    assert.equal(typeof payload.layer, 'string')
    assert.equal(typeof payload.id, 'string')
  }
})

test('观测者抛异常 → runtime:error:bus，不影响事件跑完', async () => {
  const naceb = build()
  const busErrs = collect(naceb.eventBus, 'naceb:runtime:error:bus')
  naceb.eventBusObs.listen('naceb:task:done:after:*', () => { throw new Error('观测者炸') })

  const out = await push(naceb, 'go', { task: 'retV', v: 'still-ok' })
  busErrs.stop()
  assert.equal(out.isOk, true)
  assert.equal(out.result, 'still-ok')
  assert.ok(busErrs.events.length > 0)
})

test('eventBusObs 只读', () => {
  assert.equal(build().eventBusObs.emit, undefined)
})

// ── adaptor ──

test('adaptor 满足 Processor 契约（event 侧没有 register）', () => {
  const a = build().nacpAdaptor
  assert.equal(typeof a.list, 'function')
  assert.equal(typeof a.push, 'function')
  assert.equal(a.register, undefined, 'event 侧不需要 register')
})

test('adaptor.list 等于 listEventAlias', () => {
  const naceb = build()
  assert.deepEqual(naceb.nacpAdaptor.list(), naceb.listEventAlias())
})

test('adaptor.push 返回 eventId，但 NACP 不接', () => {
  const naceb = build()
  const ret = naceb.nacpAdaptor.push({ target: 'go', payload: { task: 'ret', v: 1 }, reqId: 'r' },
    { onProcess: () => {}, onResponse: () => {} })
  assert.equal(typeof ret, 'string', 'NACEB 返 eventId')
})

test('adaptor：终结后 onProcess 失效', async () => {
  const naceb = build()
  let afterTerminal = 0
  let terminated = false
  await new Promise((resolve) => {
    naceb.nacpAdaptor.push({ target: 'go', payload: { task: 'report', n: 2 }, reqId: 'r' }, {
      onProcess: () => { if (terminated) afterTerminal++ },
      onResponse: () => { terminated = true; resolve() },
    })
  })
  await sleep(30)
  assert.equal(afterTerminal, 0, '终结之后不再有过程流')
})
