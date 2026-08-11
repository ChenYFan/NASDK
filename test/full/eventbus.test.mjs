/**
 * full/eventbus — 覆盖 EventBus 正常会走到的路径。
 *
 * simple/eventbus 是用例，这里是覆盖：通配符的各种位置、订阅生命周期、错误隔离、readonly 边界。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventBus, readonlyView } from '../../EventBus.ts'

// ── 匹配规则 ──

test('通配符可以在任意段，也可以多个', () => {
  const bus = new EventBus()
  const hit = (pattern, keys) => {
    const got = []
    const id = bus.listen(pattern, (_p, k) => got.push(k))
    for (const k of keys) bus.emit(k, {})
    bus.off(id)
    return got
  }

  assert.deepEqual(hit('a:*:c', ['a:b:c', 'a:x:c', 'a:b:d']), ['a:b:c', 'a:x:c'], '中间段')
  assert.deepEqual(hit('*:b:c', ['a:b:c', 'z:b:c', 'a:x:c']), ['a:b:c', 'z:b:c'], '首段')
  assert.deepEqual(hit('a:b:*', ['a:b:c', 'a:b:d', 'a:x:c']), ['a:b:c', 'a:b:d'], '末段')
  assert.deepEqual(hit('a:*:*', ['a:b:c', 'a:x:y', 'a:b']), ['a:b:c', 'a:x:y'], '两个星')
  assert.deepEqual(hit('*:*:*', ['a:b:c', 'x:y:z', 'a:b']), ['a:b:c', 'x:y:z'], '全星，但段数要对')
})

test('段数必须相等 —— * 不跨段、不匹配空', () => {
  const bus = new EventBus()
  const got = []
  bus.listen('a:*', (_p, k) => got.push(k))

  bus.emit('a:b', {})
  bus.emit('a:b:c', {})     // 三段，不匹配两段的模式
  bus.emit('a', {})         // 一段
  bus.emit('a:', {})        // 两段，第二段是空串 —— 仍然算一段

  assert.deepEqual(got, ['a:b', 'a:'])
})

test('精确订阅和通配符订阅同时命中', () => {
  const bus = new EventBus()
  const order = []
  bus.listen('x:y', () => order.push('exact'))
  bus.listen('x:*', () => order.push('wild'))
  bus.emit('x:y', {})
  assert.equal(order.length, 2)
  assert.deepEqual(order.sort(), ['exact', 'wild'])
})

test('没有匹配的订阅时 emit 是安全空操作', () => {
  const bus = new EventBus()
  assert.doesNotThrow(() => bus.emit('nobody:listening', { x: 1 }))
})

// ── 订阅生命周期 ──

test('同一个函数注册多次是多个独立订阅', () => {
  const bus = new EventBus()
  let n = 0
  const cb = () => n++
  const id1 = bus.listen('k', cb)
  const id2 = bus.listen('k', cb)
  assert.notEqual(id1, id2)

  bus.emit('k', {})
  assert.equal(n, 2, '两个订阅都触发')

  bus.off(id1)
  bus.emit('k', {})
  assert.equal(n, 3, '只剩一个')
})

test('listenOnce 在 emit 期间就被摘掉，不会自触发', () => {
  const bus = new EventBus()
  let n = 0
  bus.listenOnce('loop', () => { n++; bus.emit('loop', {}) })   // 回调里再 emit 同一个 key
  bus.emit('loop', {})
  assert.equal(n, 1, '不会无限递归')
})

test('listenOnce 触发前可以取消', () => {
  const bus = new EventBus()
  let fired = false
  const id = bus.listenOnce('k', () => { fired = true })
  assert.equal(bus.off(id), true)
  bus.emit('k', {})
  assert.equal(fired, false)
})

test('off 不存在的 id 返 false，不抛', () => {
  const bus = new EventBus()
  assert.equal(bus.off('sub-不存在'), false)
})

test('emit 期间新增的订阅不参与本次派发', () => {
  const bus = new EventBus()
  const got = []
  bus.listen('k', () => {
    got.push('first')
    bus.listen('k', () => got.push('added-during-emit'))
  })
  bus.emit('k', {})
  assert.deepEqual(got, ['first'], '本次只跑已存在的')
  bus.emit('k', {})
  assert.deepEqual(got, ['first', 'first', 'added-during-emit'], '下次才生效')
})

// ── hitKey ──

test('hitKey 就是 emit 的那个 key，精确订阅时等于模式本身', () => {
  const bus = new EventBus()
  const seen = []
  bus.listen('exact:name', (_p, k) => seen.push(k))
  bus.listen('exact:*', (_p, k) => seen.push(k))
  bus.emit('exact:name', {})
  assert.deepEqual(seen, ['exact:name', 'exact:name'])
})

// ── 错误隔离 ──

test('异步回调 reject 也进 onError，不冒泡', async () => {
  const bus = new EventBus()
  const errs = []
  bus.onError = (key, err) => errs.push({ key, msg: err.message })

  bus.listen('k', async () => { throw new Error('async 炸') })
  bus.emit('k', {})
  await new Promise((r) => setImmediate(r))

  assert.equal(errs.length, 1)
  assert.equal(errs[0].msg, 'async 炸')
})

test('onError 默认是空操作 —— 不设也不会崩', () => {
  const bus = new EventBus()
  bus.listen('k', () => { throw new Error('无人接管') })
  assert.doesNotThrow(() => bus.emit('k', {}))
})

test('asyncListenOnce：cb 的返回值决定 resolve 值，抛出则 reject', async () => {
  const bus = new EventBus()

  setTimeout(() => bus.emit('a', { v: 1 }, { status: 'done' }), 5)
  // cb 的 this 是 emit 侧的 thisArg，返回值成为 promise 的结果
  assert.equal(await bus.asyncListenOnce('a', function () { return this.status }), 'done')

  setTimeout(() => bus.emit('b', {}), 5)
  await assert.rejects(
    bus.asyncListenOnce('b', () => { throw new Error('await 的观测者有调用方可以报错') }),
    /await 的观测者/,
  )
})

test('asyncListenOnce 不带 cb 时 resolve 的是 payload', async () => {
  const bus = new EventBus()
  setTimeout(() => bus.emit('c', { hi: 1 }), 5)
  assert.deepEqual(await bus.asyncListenOnce('c'), { hi: 1 })
})

// ── thisArg ──

test('不传 thisArg 时 this 是 bus 本身', () => {
  const bus = new EventBus()
  let self
  bus.listen('k', function () { self = this })
  bus.emit('k', {})
  assert.equal(self, bus)
})

test('传了 thisArg 就用它', () => {
  const bus = new EventBus()
  const obj = { tag: 'mine' }
  let seen
  bus.listen('k', function () { seen = this.tag })
  bus.emit('k', {}, obj)
  assert.equal(seen, 'mine')
})

// ── readonlyView ──

test('readonlyView：读透传、方法可调、写抛错', () => {
  const target = {
    id: 'x', status: 'running',
    get computed() { return `${this.id}-${this.status}` },
    method() { return this.status },
  }
  const view = readonlyView(target)

  assert.equal(view.id, 'x', '字段透传')
  assert.equal(view.computed, 'x-running', 'getter 透传')
  assert.equal(view.method(), 'running', '方法调用时 this 绑回真对象')

  assert.throws(() => { view.status = 'done' }, /readonly/)
  assert.throws(() => { delete view.id }, /readonly/)
  assert.throws(() => Object.defineProperty(view, 'n', { value: 1 }), /readonly/)

  target.status = 'done'
  assert.equal(view.status, 'done', '真对象仍可被自己改，视图看到最新值')
})

test('readonly 视图只有四个订阅口', () => {
  const bus = new EventBus()
  assert.deepEqual(Object.keys(bus.readonly).sort(), ['asyncListenOnce', 'listen', 'listenOnce', 'off'])
})

test('readonly 的 off 能取消通过它建的订阅', () => {
  const bus = new EventBus()
  const obs = bus.readonly
  let n = 0
  const id = obs.listen('k', () => n++)
  bus.emit('k', {})
  assert.equal(obs.off(id), true)
  bus.emit('k', {})
  assert.equal(n, 1)
})

// ── 规模 ──

test('大量订阅：派发只遍历不同的通配符形状，不是全表', () => {
  const bus = new EventBus()
  let n = 0
  // 1000 个精确订阅散布在不同 key 上
  for (let i = 0; i < 1000; i++) bus.listen(`k:${i}`, () => n++)
  bus.emit('k:500', {})
  assert.equal(n, 1, '只有命中的那个触发')
})

test('maxListeners 超限只是警告，不阻止订阅', () => {
  const bus = new EventBus()
  const warns = []
  bus.onError = (_k, err) => warns.push(err.message)
  for (let i = 0; i < 60; i++) bus.listen('same:key', () => {})
  assert.ok(warns.length > 0, '发了泄漏警告')
  assert.ok(warns.some(w => w.includes('possible leak')))
  let n = 0
  bus.listen('same:key', () => n++)
  bus.emit('same:key', {})
  assert.equal(n, 1, '第 61 个照常工作')
})
