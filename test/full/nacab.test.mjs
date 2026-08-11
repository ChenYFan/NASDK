/**
 * full/nacab — 覆盖 NACAB 正常会走到的路径。
 *
 * simple/nacab 是用例，这里是覆盖：注册表语义、失败分类、观测面完整性、无泄漏、adaptor 契约。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NACAB, AbilityHandler, NACABError } from '../../NACAB/index.ts'
import { NASDKError } from '../../types.ts'
import { collect } from '../_kit.mjs'

// ── 注册 ──

test('两种注册进同一张表，互相看得见', async () => {
  class Cls extends AbilityHandler {
    name = 'cls'; description = '类式'
    async execute() { return 'from-class' }
  }
  const nacab = new NACAB({ handlers: [new Cls()] })
  nacab.register({ name: 'fn', description: '闭包式', execute: () => 'from-fn' })

  assert.deepEqual(nacab.listAbility().map(a => a.name).sort(), ['cls', 'fn'])
  assert.equal(await nacab.invoke('cls', {}), 'from-class')
  assert.equal(await nacab.invoke('fn', {}), 'from-fn')
})

test('两种注册可以互相覆盖，后来者赢', async () => {
  class Cls extends AbilityHandler {
    name = 'x'; description = '类'
    async execute() { return 'class' }
  }
  const nacab = new NACAB({ handlers: [new Cls()] })
  assert.equal(await nacab.invoke('x', {}), 'class')

  nacab.register({ name: 'x', description: '闭包', execute: () => 'fn' })
  assert.equal(await nacab.invoke('x', {}), 'fn', '闭包式覆盖了类式')
  assert.equal(nacab.listAbility().length, 1)
})

test('构造时不给 handlers 也能用', async () => {
  const nacab = new NACAB()
  assert.deepEqual(nacab.listAbility(), [])
  nacab.register({ name: 'a', description: 'x', execute: () => 1 })
  assert.equal(await nacab.invoke('a', {}), 1)
})

test('能力名可以带点、冒号、中文 —— NACAB 不解释名字', async () => {
  const nacab = new NACAB()
  for (const name of ['a.b.c', 'ns:thing', '中文能力', 'NApp.introduce', '']) {
    nacab.register({ name, description: 'x', execute: () => name })
    assert.equal(await nacab.invoke(name, {}), name)
  }
})

// ── 输入输出 ──

test('payload 原样进 execute，返回值原样出来', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'echo', description: 'x', execute: (p) => p })

  for (const v of [undefined, null, 0, '', false, { a: [1, { b: 2 }] }, [1, 2, 3]]) {
    assert.deepEqual(await nacab.invoke('echo', v), v, `payload = ${JSON.stringify(v)}`)
  }
})

test('execute 可以是同步函数，也可以是 async', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'sync', description: 'x', execute: () => 'S' })
  nacab.register({ name: 'async', description: 'x', execute: async () => 'A' })
  assert.equal(await nacab.invoke('sync', {}), 'S')
  assert.equal(await nacab.invoke('async', {}), 'A')
})

test('this 上的字段：id / input / status / state', async () => {
  class Look extends AbilityHandler {
    name = 'look'; description = 'x'
    async execute() {
      this.state.touched = true       // state 引用冻结、内容可写
      return {
        id: typeof this.id, input: this.input,
        status: this.status, state: this.state,
      }
    }
  }
  const nacab = new NACAB({ handlers: [new Look()] })
  const r = await nacab.invoke('look', { v: 1 })
  assert.equal(r.id, 'string')
  assert.deepEqual(r.input, { v: 1 })
  assert.equal(r.status, 'running', 'execute 期间是 running')
  assert.deepEqual(r.state, { touched: true })
})

test('每次 invoke 是独立实例，state 不串', async () => {
  class Counter extends AbilityHandler {
    name = 'c'; description = 'x'
    async execute() { this.state.n = (this.state.n ?? 0) + 1; return this.state.n }
  }
  const nacab = new NACAB({ handlers: [new Counter()] })
  assert.deepEqual(await Promise.all([1, 2, 3].map(() => nacab.invoke('c', {}))), [1, 1, 1])
})

// ── 失败 ──

test('未知能力：NACABError(inbound) + code', async () => {
  const nacab = new NACAB()
  await assert.rejects(nacab.invoke('无', {}), (e) => {
    assert.ok(e instanceof NACABError)
    assert.ok(e instanceof NASDKError)
    assert.equal(e.layer, 'NACAB')
    assert.equal(e.phase, 'inbound')
    assert.equal(e.code, 'unknown-ability')
    return true
  })
})

test('handler 抛非 Error 的东西也原样传出', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'str', description: 'x', execute: () => { throw '裸字符串' } })
  nacab.register({ name: 'obj', description: 'x', execute: () => { throw { code: 42 } } })

  await assert.rejects(nacab.invoke('str', {}), (e) => e === '裸字符串')
  await assert.rejects(nacab.invoke('obj', {}), (e) => e.code === 42)
})

test('async handler reject 和 throw 等价', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'rej', description: 'x', execute: () => Promise.reject(new Error('rejected')) })
  await assert.rejects(nacab.invoke('rej', {}), /rejected/)
})

test('失败之后 NACAB 仍可用', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('x') } })
  nacab.register({ name: 'good', description: 'x', execute: () => 'ok' })

  await nacab.invoke('bad', {}).catch(() => {})
  assert.equal(await nacab.invoke('good', {}), 'ok')
})

// ── 观测面 ──

test('T 事件：六条齐全，layer 段是 ability', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('x') } })

  const keys = collect(nacab.eventBus, 'nacab:*:*:*:*')

  await nacab.invoke('ok', {})
  await nacab.invoke('bad', {}).catch(() => {})
  keys.stop()

  const shapes = keys.events.map(e => e.hitKey.split(':').slice(0, 4).join(':'))
  assert.deepEqual([...new Set(shapes)].sort(), [
    'nacab:ability:done:after', 'nacab:ability:done:before',
    'nacab:ability:failure:after', 'nacab:ability:failure:before',
    'nacab:ability:running:after', 'nacab:ability:running:before',
  ])
})

test('T 事件的 before/after 夹着状态写：before 看到旧值，after 看到新值', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('x') } })

  const seen = []
  nacab.eventBusObs.listen('nacab:ability:*:*:*', function (_p, k) {
    const [, , state, half] = k.split(':')
    seen.push(`${state}:${half}=${this.status}`)
  })

  await nacab.invoke('ok', {})
  assert.deepEqual(seen, [
    'running:before=pending',    // pending 是构造初值，没有自己的 T 事件，只在这里露一次脸
    'running:after=running',
    'done:before=running',
    'done:after=done',
  ], '成功路径：每条 before 是旧值、after 是新值')

  seen.length = 0
  await nacab.invoke('bad', {}).catch(() => {})
  assert.deepEqual(seen, [
    'running:before=pending',
    'running:after=running',
    'failure:before=running',
    'failure:after=failure',
  ], '失败路径同理，running → failure')
})

test('done:after 的视图上读得到 result，failure:after 上读得到 error 原对象', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => ({ n: 42 }) })
  const boom = new Error('原因')
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw boom } })

  let result, error
  nacab.eventBusObs.listen('nacab:ability:done:after:*', function () { result = this.result })
  nacab.eventBusObs.listen('nacab:ability:failure:after:*', function () { error = this.error })

  await nacab.invoke('ok', {})
  assert.deepEqual(result, { n: 42 }, 'result 在 done 之前就写好了，观测者当场能读到')

  await nacab.invoke('bad', {}).catch(() => {})
  assert.equal(error, boom, 'error 是抛出的那个原对象，不是 message 字符串')
})

test('T 事件的 this 是只读视图，改不了', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })

  let threw = false
  nacab.eventBusObs.listen('nacab:ability:done:after:*', function () {
    try { this.status = '篡改' } catch { threw = true }
  })
  await nacab.invoke('ok', {})
  assert.equal(threw, true, '观测者不能改状态')
})

test('只读视图是每条 T 事件都包的，不止 done:after', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })

  const blocked = []
  nacab.eventBusObs.listen('nacab:ability:*:*:*', function (_p, k) {
    // 换个字段试，证明拦的是所有写而不是单挑 status
    try { this.result = '篡改' } catch { blocked.push(k.split(':').slice(2, 4).join(':')) }
  })
  await nacab.invoke('ok', {})

  assert.deepEqual(blocked, ['running:before', 'running:after', 'done:before', 'done:after'],
    '四条 T 事件的 this 都是写保护的')
})

test('T 事件的 id 段就是 AbilityInstance 的 id，同一次调用前后一致', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })

  const ids = new Set()
  nacab.eventBusObs.listen('nacab:ability:*:*:*', function (_p, k) { ids.add(k.split(':')[4]) })
  await nacab.invoke('ok', {})
  assert.equal(ids.size, 1, `一次调用只有一个 id，实得 ${[...ids]}`)
})

test('runtime：成功两条 log，失败一条 error', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('原因') } })

  const logs = collect(nacab.eventBus, 'nacab:runtime:log:*')
  const errs = collect(nacab.eventBus, 'nacab:runtime:error:*')

  await nacab.invoke('ok', {})
  assert.equal(logs.events.length, 2, 'invoke 进入 + 正常终结')
  assert.equal(errs.events.length, 0)
  assert.match(logs.events[0].payload.msg, /^invoke 'ok'/, '第一条叙述进入')
  assert.match(logs.events[1].payload.msg, /^done 'ok'/, '第二条叙述终结')
  assert.equal(logs.events[0].payload.opt.name, 'ok', 'opt.name 是能力名')

  await nacab.invoke('bad', {}).catch(() => {})
  assert.equal(errs.events.length, 1)
  assert.equal(errs.events[0].payload.opt.error.message, '原因', 'opt.error 是原对象')
  assert.equal(errs.events[0].payload.opt.name, 'bad', 'opt.name 指出是哪个能力炸的')

  await nacab.invoke('不存在', {}).catch(() => {})
  assert.equal(errs.events.length, 2, '未知能力也进 error 通道')
  assert.equal(errs.events[1].payload.opt.code, 'unknown-ability')
  assert.equal(errs.events[1].payload.opt.name, '不存在',
    '未知能力这条没有实例，id/name 只能是被找的那个名字 —— 否则观测者无从知道谁没找到')
  assert.equal(errs.events[1].payload.id, '不存在')

  logs.stop(); errs.stop()
})

test('runtime payload 形状固定 {layer,id,msg?,opt?}', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  const logs = collect(nacab.eventBus, 'nacab:runtime:log:*')
  await nacab.invoke('ok', {})
  logs.stop()

  for (const { payload } of logs.events) {
    assert.equal(payload.layer, 'ability')
    assert.equal(typeof payload.id, 'string')
    assert.equal(typeof payload.msg, 'string')
    assert.equal(typeof payload.opt, 'object')
  }
})

test('runtime 没有 message 级 —— 能力不产过程流', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  const msgs = collect(nacab.eventBus, 'nacab:runtime:message:*')
  await nacab.invoke('ok', {})
  msgs.stop()
  assert.equal(msgs.events.length, 0)
})

test('观测者抛异常 → runtime:error:bus，不影响 invoke 结果', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 'result' })
  const busErrs = collect(nacab.eventBus, 'nacab:runtime:error:bus')
  const boom = new Error('观测者炸了')
  nacab.eventBusObs.listen('nacab:ability:done:after:*', () => { throw boom })

  assert.equal(await nacab.invoke('ok', {}), 'result', 'invoke 不受影响')
  busErrs.stop()
  assert.equal(busErrs.events.length, 1)

  const { payload } = busErrs.events[0]
  assert.equal(payload.layer, 'bus')
  assert.equal(payload.id, 'bus', 'bus 自己的错不属于任何 ability 实例，id 也是 bus')
  assert.equal(payload.opt.error, boom, 'opt.error 是观测者抛的原对象')
  assert.match(payload.opt.key, /^nacab:ability:done:after:/, 'opt.key 指出是哪条事件的观测者炸的')
  assert.equal(typeof payload.msg, 'string')
})

test('runtime 只有 error/log 两个级会真的发出来', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('x') } })

  const all = collect(nacab.eventBus, 'nacab:runtime:*:*')
  await nacab.invoke('ok', {})
  await nacab.invoke('bad', {}).catch(() => {})
  all.stop()

  const levels = [...new Set(all.events.map(e => e.hitKey.split(':')[2]))].sort()
  assert.deepEqual(levels, ['error', 'log'],
    'warning 是类型里声明的级别，但 NACAB 没有任何代码路径会发它 —— 能力只有成/败，没有「继续但需注意」')
})

test('eventBusObs 是只读的，没有 emit', () => {
  const nacab = new NACAB()
  assert.equal(nacab.eventBusObs.emit, undefined)
  assert.equal(typeof nacab.eventBusObs.listen, 'function')
})

// ── 无泄漏 ──

test('1000 次调用后内部表不增长', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'a', description: 'x', execute: () => 1 })
  nacab.register({ name: 'b', description: 'x', execute: () => { throw new Error('x') } })

  for (let i = 0; i < 500; i++) {
    await nacab.invoke('a', { i })
    await nacab.invoke('b', { i }).catch(() => {})
  }

  const maps = Object.getOwnPropertyNames(nacab)
    .map(k => [k, nacab[k]?.size]).filter(([, v]) => typeof v === 'number')
  assert.deepEqual(maps, [['handlers', 2]], `只有 handlers 表，实得 ${JSON.stringify(maps)}`)
})

// ── adaptor ──

test('adaptor 满足 Processor 契约：list / push / register', () => {
  const nacab = new NACAB()
  const a = nacab.nacpAdaptor
  assert.equal(typeof a.list, 'function')
  assert.equal(typeof a.push, 'function')
  assert.equal(typeof a.register, 'function')
  assert.equal(nacab.nacpAdaptor, a, '每次取到的是同一个 adaptor —— bindProcessor 拿到的和之后观测的是一个对象')
})

test('adaptor.register 转发到同一张表', async () => {
  const nacab = new NACAB()
  nacab.nacpAdaptor.register({ name: 'viaAdaptor', description: 'x', execute: () => 'ok' })
  assert.equal(await nacab.invoke('viaAdaptor', {}), 'ok', '走 invoke 也能调到')
  assert.deepEqual(nacab.nacpAdaptor.list(), [{ name: 'viaAdaptor', description: 'x' }])
})

test('adaptor.push 成功：onResponse(result, true)，onProcess 一次都不调', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'add', description: 'x', execute: (p) => p.a + p.b })

  let processCalls = 0
  const out = await new Promise((resolve) => {
    nacab.nacpAdaptor.push(
      { target: 'add', payload: { a: 1, b: 2 }, reqId: 'r' },
      { onProcess: () => processCalls++, onResponse: (r, isOk, why) => resolve({ r, isOk, why }) },
    )
  })
  assert.deepEqual(out, { r: 3, isOk: true, why: undefined })
  assert.equal(processCalls, 0, '能力永远没有过程流')
})

test('adaptor.push 失败：whyNotOk 只报协议级，细节在 payload', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('内部原因') } })

  const detail = {}
  for (const target of ['bad', '不存在']) {
    const out = await new Promise((resolve) => {
      nacab.nacpAdaptor.push(
        { target, payload: {}, reqId: 'r' },
        { onProcess: () => {}, onResponse: (r, isOk, why) => resolve({ r, isOk, why }) },
      )
    })
    assert.equal(out.isOk, false)
    assert.equal(out.why, 'processor-failed', `${target}: NACAB 词汇不外泄`)
    assert.ok(typeof out.r.error === 'string', '细节进 payload')
    detail[target] = out.r.error
  }
  // errorDetail 取的是 message 而不是 String(err)，所以没有 "Error: " 前缀
  assert.equal(detail['bad'], '内部原因', 'handler 抛的 Error 取其 message')
  assert.match(detail['不存在'], /不存在/, '未知能力这条要说出是哪个名字没找到')
})

test('adaptor.push 的返回值 NACAB 侧是 void —— 两层 id 隔离', () => {
  const nacab = new NACAB()
  nacab.register({ name: 'a', description: 'x', execute: () => 1 })
  const ret = nacab.nacpAdaptor.push({ target: 'a', payload: {}, reqId: 'r' },
    { onProcess: () => {}, onResponse: () => {} })
  assert.equal(ret, undefined)
})
