/**
 * simple/naceb — 事件处理机：写 Task、写 Pipeline、跑一次、看过程流。
 *
 * 不走网络。NACEB 是「有状态、多步骤、会抢资源」的那一半（另一半是 NACAB）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NACEB, PipelineHandler, TaskHandler } from '../../NACEB/index.ts'

// ── Task：干活的一步。this 是 TaskInstance，输入取 this.input ──
class Double extends TaskHandler {
  name = 'double'
  description = '翻倍，并上报一次过程'
  async execute() {
    this.processingResultReport({ got: this.input })   // 显式上报才有过程流
    return this.input * 2
  }
}

class Boom extends TaskHandler {
  name = 'boom'
  description = '总是抛'
  async execute() { throw new Error('炸了') }
}

// ── Pipeline：只决定下一步跑什么，自己不干活 ──
class DoubleTwice extends PipelineHandler {
  name = 'doubleTwice'
  description = '翻倍两次'
  next(lastResult) {
    if (lastResult === undefined) {                    // 首步：从 event 的 payload 取输入
      this.state.steps = 0
      return { task: 'double', input: this.event.payload.n }
    }
    this.state.steps++                                 // state 跨步保留
    if (this.state.steps >= 2) return { task: '$terminal', input: { value: lastResult, steps: this.state.steps } }
    return { task: 'double', input: lastResult }
  }
}

class WillFail extends PipelineHandler {
  name = 'willFail'
  description = '跑一个会抛的 task'
  next(last) {
    if (last === undefined) return { task: 'boom', input: null }
    return { task: '$terminal', input: last }
  }
}

function build() {
  return new NACEB({
    pipelineHandlers: [new DoubleTwice(), new WillFail()],
    taskHandlers: [new Double(), new Boom()],
    // 对外只暴露 eventAlias 里的名字，pipeline 内部名不外泄
    eventAlias: [
      { eventName: 'calc', pipelineName: 'doubleTwice', description: '翻倍两次' },
      { eventName: 'willFail', pipelineName: 'willFail', description: '注定失败' },
    ],
  })
}

test('listEventAlias：对外声明的就是别名，不是 pipeline 名', () => {
  const decl = build().listEventAlias()
  assert.deepEqual(decl.map(d => d.name).sort(), ['calc', 'willFail'])
  assert.equal(decl.find(d => d.name === 'calc').description, '翻倍两次')
})

test('跑一次：过程流 + 终结结果', async () => {
  const naceb = build()
  const chunks = []
  const result = await new Promise((resolve, reject) => {
    naceb.nacpAdaptor.push(
      { target: 'calc', payload: { n: 3 }, reqId: 'r1' },
      {
        onProcess: (c) => chunks.push(c.got),
        onResponse: (r, isOk, why) => isOk ? resolve(r) : reject(new Error(why)),
      },
    )
  })

  assert.deepEqual(chunks, [3, 6], '两步各上报一次')
  assert.deepEqual(result, { value: 12, steps: 2 }, '3 → 6 → 12')
})

test('task 抛异常 → onResponse 拿到 isOk=false', async () => {
  const naceb = build()
  const outcome = await new Promise((resolve) => {
    naceb.nacpAdaptor.push(
      { target: 'willFail', payload: {}, reqId: 'r2' },
      { onProcess: () => {}, onResponse: (r, isOk, why) => resolve({ r, isOk, why }) },
    )
  })

  assert.equal(outcome.isOk, false)
  assert.equal(outcome.why, 'processor-failed', 'whyNotOk 只报协议级，NACEB 自己的词汇不外泄')
  assert.ok(JSON.stringify(outcome.r).includes('炸了'), '具体原因在 payload 里')
})

test('未知事件名 → 直接拒，不挂住调用方', async () => {
  const naceb = build()
  const outcome = await new Promise((resolve) => {
    naceb.nacpAdaptor.push(
      { target: '不存在的事件', payload: {}, reqId: 'r3' },
      { onProcess: () => {}, onResponse: (r, isOk, why) => resolve({ isOk, why }) },
    )
  })
  assert.equal(outcome.isOk, false)
})

test('T 事件：状态迁移可观测，naceb:{层}:{态}:{前后}:{id}', async () => {
  const naceb = build()
  const seen = []
  naceb.eventBusObs.listen('naceb:task:*:after:*', function () { seen.push(this.status) })

  await new Promise((resolve) => {
    naceb.nacpAdaptor.push(
      { target: 'calc', payload: { n: 1 }, reqId: 'r4' },
      { onProcess: () => {}, onResponse: () => resolve() },
    )
  })

  // 两个 task 各跑一轮，每轮至少经过 running 和 done
  assert.ok(seen.includes('running'), `看到 running：${seen.join(',')}`)
  assert.ok(seen.includes('done'), `看到 done：${seen.join(',')}`)
})

test('runtime 事件：message 级就是过程流', async () => {
  const naceb = build()
  const msgs = []
  naceb.eventBusObs.listen('naceb:runtime:message:*', (p) => msgs.push(p))

  await new Promise((resolve) => {
    naceb.nacpAdaptor.push(
      { target: 'calc', payload: { n: 5 }, reqId: 'r5' },
      { onProcess: () => {}, onResponse: () => resolve() },
    )
  })

  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].layer, 'task')
  assert.deepEqual(msgs[0].opt.chunk, { got: 5 }, 'chunk 骑在 opt 上')
})

test('busyKeys：声明占用同一把 key 的 task 不会并发', async () => {
  // 这是 NACEB 存在的主要理由：GPU 这类独占资源，靠声明而不是靠调用方自己加锁
  class Gpu extends TaskHandler {
    name = 'gpu'
    description = '占 GPU'
    busyKeys = ['gpu']
    async execute() {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return this.input
    }
  }
  class One extends PipelineHandler {
    name = 'one'
    description = '跑一个 gpu task'
    next(last) { return last === undefined ? { task: 'gpu', input: 1 } : { task: '$terminal', input: last } }
  }
  let running = 0, peak = 0

  const naceb = new NACEB({
    pipelineHandlers: [new One()], taskHandlers: [new Gpu()],
    eventAlias: [{ eventName: 'useGpu', pipelineName: 'one', description: '用一次 GPU' }],
  })

  // 同时丢三个进去
  await Promise.all([1, 2, 3].map((i) => new Promise((resolve) => {
    naceb.nacpAdaptor.push(
      { target: 'useGpu', payload: {}, reqId: `g${i}` },
      { onProcess: () => {}, onResponse: () => resolve() },
    )
  })))

  assert.equal(peak, 1, `同一把 busyKey 最多一个在跑，实际峰值 ${peak}`)
})
