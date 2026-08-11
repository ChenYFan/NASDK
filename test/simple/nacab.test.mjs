/**
 * simple/nacab — 能力处理机：注册一个函数、调用它、看观测事件。
 *
 * 不走网络。NACAB 是「一次调用、无状态、瞬时」的那一半（另一半是 NACEB）。
 * 没有 pipeline、没有 tick、没有 hook、没有 busyKey、没有过程流 —— 本质就是一个 Map 加一套观测。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NACAB, AbilityHandler } from '../../NACAB/index.ts'
import { NASDKError } from '../../types.ts'

test('register：闭包式注册，最省事的写法', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'math.add', description: '两数相加', execute: (payload) => payload.a + payload.b })

  assert.equal(await nacab.invoke('math.add', { a: 20, b: 22 }), 42)
})

test('registerHandler：类式注册，execute 里能用 this', async () => {
  class Echo extends AbilityHandler {
    name = 'echo'
    description = '回显输入'
    async execute() {
      // this 是 AbilityInstance：input / id / status / state 都在
      return { got: this.input, status: this.status, hasId: typeof this.id === 'string' }
    }
  }
  const nacab = new NACAB({ handlers: [new Echo()] })

  assert.deepEqual(await nacab.invoke('echo', { hi: 1 }), { got: { hi: 1 }, status: 'running', hasId: true })
})

test('listAbility：对外声明的能力清单', () => {
  const nacab = new NACAB()
  nacab.register({ name: 'a', description: '甲', execute: () => 1 })
  nacab.register({ name: 'b', description: '乙', execute: () => 2 })

  assert.deepEqual(nacab.listAbility(), [
    { name: 'a', description: '甲' },
    { name: 'b', description: '乙' },
  ])
})

test('重名后注册的赢，和普通 Map 一样', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'x', description: '旧', execute: () => 'old' })
  nacab.register({ name: 'x', description: '新', execute: () => 'new' })

  assert.equal(await nacab.invoke('x', {}), 'new')
  assert.equal(nacab.listAbility().length, 1)
})

test('handler 抛异常：原样抛出，栈和自定义字段都在', async () => {
  const nacab = new NACAB()
  nacab.register({
    name: 'boom', description: '炸',
    execute: () => { const e = new Error('业务失败'); e.detail = { code: 7 }; throw e },
  })

  await assert.rejects(nacab.invoke('boom', {}), (e) => {
    assert.ok(e instanceof Error, '是真 Error 不是字符串')
    assert.equal(e.message, '业务失败')
    assert.ok(e.stack, '栈没丢')
    assert.deepEqual(e.detail, { code: 7 }, '自定义字段没丢')
    return true
  })
})

test('未知能力：抛 NASDKError，code 可判', async () => {
  const nacab = new NACAB()
  await assert.rejects(nacab.invoke('不存在', {}), (e) => {
    assert.ok(e instanceof NASDKError)
    assert.equal(e.code, 'unknown-ability')
    assert.equal(e.layer, 'NACAB')
    return true
  })
})

test('T 事件：nacab:ability:{态}:{前后}:{id}', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 'done' })

  const seen = []
  for (const state of ['running', 'done', 'failure']) {
    for (const phase of ['before', 'after']) {
      nacab.eventBusObs.listen(`nacab:ability:${state}:${phase}:*`, function () {
        seen.push(`${state}:${phase}=${this.status}`)   // this 是 AbilityInstance 只读视图
      })
    }
  }

  await nacab.invoke('ok', {})

  // before 在写 status 之前发，after 在之后发
  assert.deepEqual(seen, [
    'running:before=pending', 'running:after=running',
    'done:before=running', 'done:after=done',
  ])
})

test('runtime 事件：三级，没有 message（能力不产过程流）', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('nope') } })

  const got = { log: [], error: [], warning: [], message: [] }
  for (const level of Object.keys(got)) {
    nacab.eventBusObs.listen(`nacab:runtime:${level}:*`, (p) => got[level].push(p))
  }

  await nacab.invoke('ok', {})
  assert.equal(got.log.length, 2, '进入 + 终结各一条')
  assert.equal(got.log[0].layer, 'ability')
  assert.equal(got.log[0].opt.name, 'ok')

  await nacab.invoke('bad', {}).catch(() => {})
  assert.equal(got.error.length, 1)
  assert.ok(got.error[0].opt.error instanceof Error, '原 Error 对象在 opt.error 上')

  assert.equal(got.message.length, 0, 'message 级永远不会有')
})

test('并发调用互不影响', async () => {
  const nacab = new NACAB()
  nacab.register({
    name: 'slow', description: 'x',
    execute: async (p) => { await new Promise((r) => setTimeout(r, 10 - p.n)); return p.n },
  })

  // 没有 tick、没有队列、没有 busyKey —— 三个一起跑，各自返回
  assert.deepEqual(
    await Promise.all([1, 2, 3].map((n) => nacab.invoke('slow', { n }))),
    [1, 2, 3],
  )
})

test('nacpAdaptor：给 NACP 用的那层壳', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'add', description: '加', execute: (p) => p.a + p.b })

  assert.deepEqual(nacab.nacpAdaptor.list(), [{ name: 'add', description: '加' }])

  const ok = await new Promise((resolve) => {
    nacab.nacpAdaptor.push(
      { target: 'add', payload: { a: 1, b: 2 }, reqId: 'r1' },
      { onProcess: () => assert.fail('能力不该有过程流'), onResponse: (r, isOk) => resolve({ r, isOk }) },
    )
  })
  assert.deepEqual(ok, { r: 3, isOk: true })

  const bad = await new Promise((resolve) => {
    nacab.nacpAdaptor.push(
      { target: '没有', payload: {}, reqId: 'r2' },
      { onProcess: () => {}, onResponse: (r, isOk, why) => resolve({ isOk, why }) },
    )
  })
  assert.equal(bad.isOk, false)
  assert.equal(bad.why, 'processor-failed', 'NACAB 自己的错误码不外泄到协议层')
})
