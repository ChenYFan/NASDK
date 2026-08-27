/**
 * edge/naceb — 临界值与压力。
 *
 * full/naceb 覆盖正常路径，这里挑规模与退化：大量事件排队、资源锁下的吞吐、深层 SubEvent、
 * 时钟在极端队列下的行为、handler 抛非 Error、pause 撞上不合作的 handler。
 *
 * 每个测试都必须消费掉自己的终态事件 —— 终态事件留在队列里会让 NACEB 的时钟一直转，
 * 进程就不退出了（这是产品行为，不是 bug）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NACEB, PipelineHandler, TaskHandler, TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT } from '../../NACEB/index.ts'
import { VetoT } from '../../NACEB/errors.ts'
import { collect, timed, sleep } from '../_kit.mjs'
import { z } from 'zod'

const SLOW = !!process.env.NASDK_SLOW

// ── handler ──

class Ret extends TaskHandler {
  name = 'ret'
  description = '原样返回 input'
  async execute() { return this.input }
}

class Fast extends TaskHandler {
  name = 'fast'
  description = '立刻返回，不 await'
  execute() { return this.input?.v ?? 0 }
}

class Gpu extends TaskHandler {
  name = 'gpu'
  description = '占 gpu 一段时间'
  busyKeys = ['gpu']
  async execute() {
    const s = this.input.stats
    s.now++; s.peak = Math.max(s.peak, s.now); s.total++
    await sleep(this.input.ms ?? 5)
    s.now--
    return s.total
  }
}

class ThrowWeird extends TaskHandler {
  name = 'throwWeird'
  description = '抛非 Error'
  async execute() { throw this.input?.what }
}

/** 不看 abortSignal —— pause 只能等 stopTimeoutMs。edge 专用。 */
class Stubborn extends TaskHandler {
  name = 'stubborn'
  description = '不响应 abort'
  async execute() { return new Promise((r) => { (this.pipeline.event.payload.release ??= []).push(r) }) }
}

class Coop extends TaskHandler {
  name = 'coop'
  description = '响应 abort'
  async execute() {
    for (let i = 0; i < 600; i++) {
      if (this.abortSignal?.aborted) throw new Error('aborted')
      if (this.pipeline.event.payload.done) return 'finished'
      await sleep(5)
    }
    return 'never'
  }
}

class One extends PipelineHandler {
  name = 'one'
  description = '一步'
  next(last) {
    if (last === undefined) return { task: this.event.payload?.task ?? 'ret', input: this.event.payload }
    return { task: TERMINAL, input: last }
  }
}

class ManyStep extends PipelineHandler {
  name = 'manyStep'
  description = '跑 steps 次 fast'
  next(last) {
    if (last === undefined) this.state.left = this.event.payload?.steps ?? 10
    if (this.state.left-- > 0) return { task: 'fast', input: this.event.payload }
    return { task: TERMINAL, input: { steps: this.event.payload?.steps } }
  }
}

const build = (extra = {}) => new NACEB({
  pipelineHandlers: [new One(), new ManyStep(), ...(extra.pipelines ?? [])],
  taskHandlers: [new Ret(), new Fast(), new Gpu(), new ThrowWeird(), new Stubborn(), new Coop(), ...(extra.tasks ?? [])],
  eventAlias: [
    { eventName: 'go', pipelineName: 'one', description: '一步' },
    { eventName: 'many', pipelineName: 'manyStep', description: '多步' },
    ...(extra.alias ?? []),
  ],
})

/** 等到事件到终态；返回实际等了多久。超时就抛（避免整套挂死）。 */
async function settle(naceb, id, ms = 20000) {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    const s = naceb.getEvent(id)?.status
    if (s === 'done' || s === 'failure') return performance.now() - t0
    if (s === undefined) return performance.now() - t0        // 已被消费
    await sleep(5)
  }
  throw new Error(`event ${id} 在 ${ms}ms 内没到终态（当前 ${naceb.getEvent(id)?.status}）`)
}

/** 消费掉所有终态事件（先取 id 快照，避免遍历时改动集合）。 */
function drain(naceb) {
  for (const id of naceb.listEvent().map(e => e.id)) {
    const e = naceb.getEvent(id)
    if (e && (e.status === 'done' || e.status === 'failure')) naceb.consumeEvent(id)
  }
}

// ── 队列规模 ──

test('1000 个事件排队，全部跑完且结果各归各位', async () => {
  const naceb = build()
  const ids = []
  const [, pushMs] = await timed(async () => {
    for (let i = 0; i < 1000; i++) ids.push(naceb.pushEvent({ name: 'go', payload: { task: 'fast', v: i } }, { bypassIdle: true }))
  })

  const [, runMs] = await timed(async () => { for (const id of ids) await settle(naceb, id) })

  for (let i = 0; i < ids.length; i++) {
    assert.equal(naceb.getEvent(ids[i]).status, 'done', `第 ${i} 个`)
    assert.equal(naceb.consumeEvent(ids[i]), i, `第 ${i} 个拿回自己的 v`)
  }
  console.log(`    1000 事件 push: ${pushMs.toFixed(0)}ms; 跑完: ${runMs.toFixed(0)}ms (${(1000 / (runMs / 1000)).toFixed(0)} ev/s)`)
  assert.equal(naceb.listEvent().length, 0, '队列清空')
})

test('1000 个事件停在 idle 不消耗时钟，再一起放行', async () => {
  const naceb = build()
  // pushEvent 默认停在 idle —— 刻意留的窗口，用来挂 hook
  const ids = Array.from({ length: 1000 }, (_, i) =>
    naceb.pushEvent({ name: 'go', payload: { task: 'fast', v: i } }))

  await sleep(120)
  assert.ok(naceb.listEvent().every(e => e.status === 'idle'), '全在 idle 等着')

  const [, ms] = await timed(async () => {
    for (const id of ids) naceb.getEvent(id).start()
    for (const id of ids) await settle(naceb, id)
  })
  assert.ok(ids.every(id => naceb.getEvent(id).status === 'done'))
  console.log(`    1000 个 idle 事件一起放行跑完: ${ms.toFixed(0)}ms`)
  drain(naceb)
})

test('单事件 200 步流水线', async () => {
  const naceb = build()
  const id = naceb.pushEvent({ name: 'many', payload: { steps: 200 } }, { bypassIdle: true })
  const [, ms] = await timed(() => settle(naceb, id))
  assert.equal(naceb.getEvent(id).status, 'done')
  assert.deepEqual(naceb.consumeEvent(id), { steps: 200 })
  console.log(`    200 步流水线: ${ms.toFixed(0)}ms (${(ms / 200).toFixed(2)}ms/步)`)
})

test('50 个事件 × 20 步并发，共 1000 个 task 分派', async () => {
  const naceb = build()
  const ids = Array.from({ length: 50 }, () => naceb.pushEvent({ name: 'many', payload: { steps: 20 } }, { bypassIdle: true }))
  const [, ms] = await timed(async () => { for (const id of ids) await settle(naceb, id) })
  assert.ok(ids.every(id => naceb.getEvent(id).status === 'done'))
  console.log(`    50 事件 × 20 步 = 1000 task: ${ms.toFixed(0)}ms`)
  drain(naceb)
})

// ── 资源锁下的吞吐 ──

test('100 个抢同一把 busyKey：严格串行，peak 恒为 1', async () => {
  const naceb = build()
  const stats = { now: 0, peak: 0, total: 0 }
  const ids = Array.from({ length: 100 }, () =>
    naceb.pushEvent({ name: 'go', payload: { task: 'gpu', stats, ms: 1 } }, { bypassIdle: true }))

  const [, ms] = await timed(async () => { for (const id of ids) await settle(naceb, id) })
  assert.equal(stats.peak, 1, `同一把 key 永不并发，实测 peak=${stats.peak}`)
  assert.equal(stats.total, 100, '100 个都跑了')
  assert.equal(stats.now, 0, '全部释放')
  console.log(`    100 个争同一把 busyKey: ${ms.toFixed(0)}ms (${(ms / 100).toFixed(1)}ms/个，含调度开销)`)
  drain(naceb)
})

test('无 busyKeys 的 task 完全并发 —— 与上一条对照', async () => {
  const naceb = build()
  let now = 0, peak = 0
  class Free extends TaskHandler {
    name = 'free'
    description = '不占 key'
    async execute() { now++; peak = Math.max(peak, now); await sleep(20); now--; return 1 }
  }
  const n2 = build({ tasks: [new Free()] })
  const ids = Array.from({ length: 50 }, () => n2.pushEvent({ name: 'go', payload: { task: 'free' } }, { bypassIdle: true }))
  await Promise.all(ids.map(id => settle(n2, id)))
  assert.ok(peak > 1, `无 key 的 task 真的并发了，peak=${peak}`)
  console.log(`    50 个无 busyKey 的 task: peak 并发 = ${peak}`)
  drain(n2)
})

test('两把 key 各自串行、彼此并行', async () => {
  class Cpu extends TaskHandler {
    name = 'cpu'
    description = '占 cpu'
    busyKeys = ['cpu']
    async execute() {
      const s = this.input.stats
      s.cpuNow++; s.cpuPeak = Math.max(s.cpuPeak, s.cpuNow)
      s.bothNow++; s.bothPeak = Math.max(s.bothPeak, s.bothNow)
      await sleep(10)
      s.cpuNow--; s.bothNow--
      return 'cpu'
    }
  }
  class Gpu2 extends TaskHandler {
    name = 'gpu2'
    description = '占 gpu'
    busyKeys = ['gpu']
    async execute() {
      const s = this.input.stats
      s.gpuNow++; s.gpuPeak = Math.max(s.gpuPeak, s.gpuNow)
      s.bothNow++; s.bothPeak = Math.max(s.bothPeak, s.bothNow)
      await sleep(10)
      s.gpuNow--; s.bothNow--
      return 'gpu'
    }
  }
  const naceb = build({ tasks: [new Cpu(), new Gpu2()] })
  const stats = { cpuNow: 0, cpuPeak: 0, gpuNow: 0, gpuPeak: 0, bothNow: 0, bothPeak: 0 }
  const ids = []
  for (let i = 0; i < 20; i++) {
    ids.push(naceb.pushEvent({ name: 'go', payload: { task: 'cpu', stats } }, { bypassIdle: true }))
    ids.push(naceb.pushEvent({ name: 'go', payload: { task: 'gpu2', stats } }, { bypassIdle: true }))
  }
  await Promise.all(ids.map(id => settle(naceb, id)))

  assert.equal(stats.cpuPeak, 1, 'cpu 这把串行')
  assert.equal(stats.gpuPeak, 1, 'gpu 这把串行')
  assert.equal(stats.bothPeak, 2, '两把 key 之间是并行的 —— 这才是分 lane 的意义')
  drain(naceb)
})

// ── SubEvent 深度 ──

test('SubEvent 嵌套 20 层', async () => {
  class Recurse extends PipelineHandler {
    name = 'recurse'
    description = '递归起子事件'
    next(last) {
      const depth = this.event.payload?.depth ?? 0
      if (last === undefined) {
        if (depth <= 0) return { task: 'fast', input: { v: 0 } }
        return { task: WAIT4SUBEVENT, input: { pipelineName: 'recurse', payload: { depth: depth - 1 } } }
      }
      return { task: TERMINAL, input: typeof last === 'number' ? last + 1 : (last ?? 0) + 1 }
    }
  }
  const naceb = build({ pipelines: [new Recurse()], alias: [{ eventName: 'rec', pipelineName: 'recurse', description: '递归' }] })
  const id = naceb.pushEvent({ name: 'rec', payload: { depth: 20 } }, { bypassIdle: true })
  const [, ms] = await timed(() => settle(naceb, id))
  assert.equal(naceb.getEvent(id).status, 'done', '20 层递归子事件跑通')
  console.log(`    20 层嵌套 SubEvent: ${ms.toFixed(0)}ms`)
  drain(naceb)
})

test('一个父事件 fire 50 个子事件', async () => {
  class FireMany extends PipelineHandler {
    name = 'fireMany'
    description = '连发子事件'
    next(last) {
      if (last === undefined) this.state.left = 50
      if (this.state.left-- > 0) return { task: FIRE4SUBEVENT, input: { pipelineName: 'one', payload: { task: 'fast', v: 1 } } }
      return { task: TERMINAL, input: { fired: 50 } }
    }
  }
  const naceb = build({ pipelines: [new FireMany()], alias: [{ eventName: 'fire50', pipelineName: 'fireMany', description: '连发' }] })
  const id = naceb.pushEvent({ name: 'fire50', payload: {} }, { bypassIdle: true })
  const [, ms] = await timed(() => settle(naceb, id))
  assert.deepEqual(naceb.consumeEvent(id), { fired: 50 })
  await sleep(300)                                    // 让子事件各自跑完
  console.log(`    fire 50 个子事件: ${ms.toFixed(0)}ms`)
  drain(naceb)
})

// ── 退化输入 ──

test('task 抛非 Error：字符串 / 数字 / null / undefined / Symbol', async () => {
  const naceb = build()
  for (const what of ['字符串', 42, null, undefined, Symbol.for('sym'), { code: 'x' }]) {
    const id = naceb.pushEvent({ name: 'go', payload: { task: 'throwWeird', what } }, { bypassIdle: true })
    await settle(naceb, id)
    assert.equal(naceb.getEvent(id).status, 'failure', `抛 ${String(what)} 也能落 failure，不会卡住`)
    const final = naceb.consumeEvent(id)
    assert.ok(final && typeof final.error === 'string', `error 被规约成字符串，实得 ${typeof final?.error}`)
  }
})

test('payload 是各种退化值都不炸', async () => {
  const naceb = build()
  for (const payload of [{}, { task: 'fast' }, { task: 'fast', v: null }, { task: 'fast', v: undefined }]) {
    const id = naceb.pushEvent({ name: 'go', payload }, { bypassIdle: true })
    await settle(naceb, id)
    assert.equal(naceb.getEvent(id).status, 'done', JSON.stringify(payload))
    naceb.consumeEvent(id)
  }
})

test('1MB payload 穿过流水线', async () => {
  const naceb = build()
  const big = 'B'.repeat(1024 * 1024)
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', big } }, { bypassIdle: true })
  const [, ms] = await timed(() => settle(naceb, id))
  const out = naceb.consumeEvent(id)
  assert.equal(out.big, big, '原样穿过，NACEB 不碰 payload')
  console.log(`    1MB payload 过流水线: ${ms.toFixed(0)}ms`)
})

test('未注册的 pipeline / alias：立刻拒，不留半个事件', async () => {
  const naceb = build()
  assert.throws(() => naceb.pushEvent({ name: '没这个别名', payload: {} }, { bypassIdle: true }))
  assert.equal(naceb.listEvent().length, 0, '拒了就是一个都没建')
})

test('next() 指向不存在的 task → 事件落 failure', async () => {
  class BadNext extends PipelineHandler {
    name = 'badNext'
    description = '指向不存在的 task'
    next() { return { task: '压根没这个task', input: {} } }
  }
  const naceb = build({ pipelines: [new BadNext()], alias: [{ eventName: 'bad', pipelineName: 'badNext', description: 'x' }] })
  const id = naceb.pushEvent({ name: 'bad', payload: {} }, { bypassIdle: true })
  await settle(naceb, id)
  assert.equal(naceb.getEvent(id).status, 'failure')
  naceb.consumeEvent(id)
})

// ── Veto 压力 ──

test('连续否决 100 次后放行 —— veto 靠下拍重试收敛', async () => {
  const naceb = build()
  let n = 0
  const warns = collect(naceb.eventBus, 'naceb:runtime:warning:*')
  const id = naceb.pushEvent(
    { name: 'go', payload: { task: 'fast', v: 1 } },
    { hooks: { beforeTActivating() { if (++n <= 100) throw new VetoT(`no.${n}`) } }, bypassIdle: true },
  )
  const [, ms] = await timed(() => settle(naceb, id))
  warns.stop()

  assert.equal(naceb.getEvent(id).status, 'done', '100 次否决只是推迟，最终仍放行')
  assert.equal(n, 101, `进了 101 次 hook（否决 100 + 放行 1），实得 ${n}`)
  const vetoWarns = warns.events.filter(e => e.payload.opt?.reason === 'beforeTActivating-vetoed')
  assert.equal(vetoWarns.length, 100, '每次否决一条 warning')
  console.log(`    100 次连续 veto 后放行: ${ms.toFixed(0)}ms (${(ms / 100).toFixed(1)}ms/拍)`)
  naceb.consumeEvent(id)
})

test('终局 veto 无论试几次都不可否决 —— 不会死循环', async () => {
  const naceb = build()
  let n = 0
  const id = naceb.pushEvent(
    { name: 'go', payload: { task: 'fast', v: 1 } },
    { hooks: { beforeTDone() { n++; throw new VetoT('不想结束') } }, bypassIdle: true },
  )
  await settle(naceb, id)
  assert.equal(naceb.getEvent(id).status, 'done')
  assert.equal(n, 1, '只进一次 —— 终局 veto 被降级放行，没有下一拍再来一遍')
  naceb.consumeEvent(id)
})

// ── 观测面高频 ──

test('单事件 100 步的观测事件量', async () => {
  const naceb = build()
  const tEvents = collect(naceb.eventBus, 'naceb:*:*:*:*')
  const logs = collect(naceb.eventBus, 'naceb:runtime:log:*')
  const id = naceb.pushEvent({ name: 'many', payload: { steps: 100 } }, { bypassIdle: true })
  await settle(naceb, id)
  tEvents.stop(); logs.stop()

  // 只断言量级关系，不写死数字 —— 具体条数依赖状态机边数，改一条边就假红
  assert.ok(tEvents.events.length > 100, `T 事件随步数增长，实得 ${tEvents.events.length}`)
  const layers = new Set(tEvents.events.map(e => e.hitKey.split(':')[1]))
  assert.deepEqual([...layers].sort(), ['event', 'pipeline', 'task'], '三层都有')
  console.log(`    100 步事件的观测量: ${tEvents.events.length} 条 T 事件, ${logs.events.length} 条 log`)
  naceb.consumeEvent(id)
})

test('挂 200 个观测者不影响事件跑完', async () => {
  const naceb = build()
  naceb.eventBus.onError = () => {}
  let fired = 0
  for (let i = 0; i < 200; i++) naceb.eventBusObs.listen('naceb:event:done:after:*', () => fired++)
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'fast', v: 9 } }, { bypassIdle: true })
  await settle(naceb, id)
  assert.equal(naceb.consumeEvent(id), 9)
  assert.equal(fired, 200)
})

// ── 时钟 ──

test('空队列时时钟应当停下 —— 消费完终态事件后进程能退出', async () => {
  // 这是本文件每个测试都要 drain 的原因：终态事件留在队列里，队列非空 ⇒ 还要 tick，
  // 时钟就永远转下去。这条把这个契约本身钉住。
  const naceb = build()
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'fast', v: 1 } }, { bypassIdle: true })
  await settle(naceb, id)
  assert.equal(naceb.listEvent().length, 1, '终态事件还在队列里')
  naceb.consumeEvent(id)
  assert.equal(naceb.listEvent().length, 0, '消费后队列空 —— 时钟这才能停')
})

// ── 超时路径（默认 skip）──

test('pause 撞上不响应 abort 的 handler：等满 stopTimeoutMs(120s)', { skip: !SLOW }, async () => {
  // 协作式取消的必然结果：handler 不看 abortSignal，框架只能等到 stopTimeoutMs。
  // 不是 bug，但真等 2 分钟，所以默认 skip。
  const naceb = build()
  const payload = { task: 'stubborn', release: [] }
  const id = naceb.pushEvent({ name: 'go', payload }, { bypassIdle: true })
  await sleep(100)
  const ev = naceb.getEvent(id)
  const [ok, ms] = await timed(() => ev.pause())
  console.log(`    pause 在不合作的 handler 上花了 ${(ms / 1000).toFixed(1)}s (stopTimeoutMs=120s)`)
  assert.ok(ms > 100_000, `真的等满了超时，实测 ${ms.toFixed(0)}ms`)
  assert.equal(ok, true, '超时视为收尾，pause 仍报成功')
  payload.release.forEach(r => r('late'))
  drain(naceb)
})

test('pause 在响应 abort 的 handler 上是毫秒级 —— 与上一条对照', async () => {
  const naceb = build()
  const payload = { task: 'coop', done: false }
  const id = naceb.pushEvent({ name: 'go', payload }, { bypassIdle: true })
  await sleep(60)
  const ev = naceb.getEvent(id)
  const [ok, ms] = await timed(() => ev.pause())
  assert.equal(ok, true)
  assert.ok(ms < 1000, `合作的 handler 让 pause 立刻返回，实测 ${ms.toFixed(1)}ms`)
  console.log(`    pause 在合作的 handler 上: ${ms.toFixed(1)}ms（对照：不合作要 120s）`)

  payload.done = true
  await ev.resume()
  await settle(naceb, id)
  drain(naceb)
})

// ── payloadSchema：task 输入闸门 ──
//
// TaskHandler.payloadSchema（可选）在 dispatch 处 safeParse(step.input)。纯闸门：parse 输出丢弃，
// execute 拿原始 input（多余字段原样留）。拒绝 → 抛 → pipeline failure → event failure（硬失败，不重试）。

/** 声明 payloadSchema 的 task；execute 把实际拿到的 input 原样回吐，供测试检查"多余字段是否还在"。 */
class Gated extends TaskHandler {
  name = 'gated'
  description = '带 payloadSchema 的 task，原样回吐 input'
  payloadSchema = z.object({ n: z.number() })
  async execute() { return this.input }
}

/** 把 event.payload.step 当 step.input 直接喂给目标 task（让测试能精确控制流入形状）。 */
class ToGated extends PipelineHandler {
  name = 'toGated'
  description = '把 payload.step 喂给 gated'
  next(last) {
    if (last === undefined) return { task: 'gated', input: this.event.payload.step }
    return { task: TERMINAL, input: last }
  }
}

const buildGated = () => build({
  pipelines: [new ToGated()],
  tasks: [new Gated()],
  alias: [{ eventName: 'gate', pipelineName: 'toGated', description: 'x' }],
})

test('payloadSchema 拒绝坏输入 → 事件落 failure（不留半个 task）', async () => {
  const naceb = buildGated()
  const id = naceb.pushEvent({ name: 'gate', payload: { step: { n: '不是数字' } } }, { bypassIdle: true })
  await settle(naceb, id)
  assert.equal(naceb.getEvent(id).status, 'failure', '形状不符 → failure')
  const final = naceb.consumeEvent(id)
  assert.match(String(final.error), /input rejected/, 'failure 带 bad-task-input 原因')
})

test('不填 payloadSchema → 无约束，任意输入放行', async () => {
  const naceb = build()   // ret / fast 都没声明 payloadSchema
  const id = naceb.pushEvent({ name: 'go', payload: { task: 'ret', 啥都行: true, n: 'xyz' } }, { bypassIdle: true })
  await settle(naceb, id)
  assert.equal(naceb.getEvent(id).status, 'done', '无 schema 的 task 不校验，直接跑完')
  naceb.consumeEvent(id)
})

test('纯闸门：多余字段原样进 execute，不被 strip/coerce', async () => {
  const naceb = buildGated()
  // n 合法（过闸门），额外带 extra 字段 —— A 语义要求 execute 仍拿到原始 input（含 extra）
  const id = naceb.pushEvent({ name: 'gate', payload: { step: { n: 42, extra: 'kept', nested: { a: 1 } } } }, { bypassIdle: true })
  await settle(naceb, id)
  assert.equal(naceb.getEvent(id).status, 'done')
  const out = naceb.consumeEvent(id)
  assert.deepEqual(out, { n: 42, extra: 'kept', nested: { a: 1 } }, 'execute 拿到的是原始 input，多余字段没被 zod strip')
})
