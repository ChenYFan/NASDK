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

  await nacab.invoke('bad', {}).catch(() => {})
  assert.equal(errs.events.length, 1)
  assert.equal(errs.events[0].payload.opt.error.message, '原因', 'opt.error 是原对象')

  await nacab.invoke('不存在', {}).catch(() => {})
  assert.equal(errs.events.length, 2, '未知能力也进 error 通道')
  assert.equal(errs.events[1].payload.opt.code, 'unknown-ability')

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
  nacab.eventBusObs.listen('nacab:ability:done:after:*', () => { throw new Error('观测者炸了') })

  assert.equal(await nacab.invoke('ok', {}), 'result', 'invoke 不受影响')
  busErrs.stop()
  assert.equal(busErrs.events.length, 1)
  assert.equal(busErrs.events[0].payload.layer, 'bus')
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
  const a = new NACAB().nacpAdaptor
  assert.equal(typeof a.list, 'function')
  assert.equal(typeof a.push, 'function')
  assert.equal(typeof a.register, 'function')
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
  }
})

test('adaptor.push 的返回值 NACAB 侧是 void —— 两层 id 隔离', () => {
  const nacab = new NACAB()
  nacab.register({ name: 'a', description: 'x', execute: () => 1 })
  const ret = nacab.nacpAdaptor.push({ target: 'a', payload: {}, reqId: 'r' },
    { onProcess: () => {}, onResponse: () => {} })
  assert.equal(ret, undefined)
})
