/**
 * edge/eventbus — 临界值与压力。
 *
 * full/eventbus 覆盖规则本身，这里挑规模与边界：大量订阅时的派发成本、maxListeners 的确切阈值、
 * key 的退化形状（空段、超长、超多段）、递归 emit 会爆栈这件事。
 *
 * 性能只打印。EventBus 是根级热路径，派发成本的量级值得留个记录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventBus, readonlyView } from '../../EventBus.ts'
import { timed } from '../_kit.mjs'

// ── 规模 ──

test('10000 个精确订阅散在不同 key，派发只碰命中的那个', async () => {
  const bus = new EventBus()
  let hits = 0
  for (let i = 0; i < 10000; i++) bus.listen(`k:${i}`, () => hits++)

  const [, ms] = await timed(async () => { for (let i = 0; i < 1000; i++) bus.emit(`k:${i}`, {}) })
  assert.equal(hits, 1000, '一次 emit 只命中一个')
  console.log(`    10000 订阅 / 1000 次 emit: ${ms.toFixed(1)}ms (${(ms / 1000 * 1000).toFixed(1)}µs/emit)`)
})

test('同一 key 上 5000 个订阅，一次 emit 全触发', async () => {
  const bus = new EventBus()
  bus.onError = () => {}              // 吃掉 maxListeners 警告
  let hits = 0
  for (let i = 0; i < 5000; i++) bus.listen('same', () => hits++)

  const [, ms] = await timed(async () => bus.emit('same', {}))
  assert.equal(hits, 5000)
  console.log(`    5000 listener 单次 emit: ${ms.toFixed(1)}ms`)
})

test('派发成本取决于「注册过几种形状」，而不是 key 有几段', async () => {
  // 实现是按 (段数 + 通配掩码 + 字面段) 分桶，emit 只遍历**实际注册过**的形状。
  // 所以 10 段 key 只订精确一种时，查找只走 1 个桶 —— 比 3 段 key 订满 8 种形状还便宜。
  // 这条对照钉住这个反直觉但正确的事实。
  const wide = new EventBus()
  const wideKey = Array.from({ length: 10 }, (_, i) => `s${i}`).join(':')
  let wideHits = 0
  wide.listen(wideKey, () => wideHits++)                            // 10 段，1 种形状
  const [, wideMs] = await timed(async () => { for (let i = 0; i < 10000; i++) wide.emit(wideKey, {}) })
  assert.equal(wideHits, 10000)

  const many = new EventBus()
  let manyHits = 0
  for (const p of ['a:b:c', 'a:b:*', 'a:*:c', 'a:*:*', '*:b:c', '*:b:*', '*:*:c', '*:*:*']) {
    many.listen(p, () => manyHits++)                                // 3 段，8 种形状
  }
  const [, manyMs] = await timed(async () => { for (let i = 0; i < 10000; i++) many.emit('a:b:c', {}) })
  assert.equal(manyHits, 8 * 10000, '八种形状全命中')

  console.log(`    10 段/1 种形状: ${wideMs.toFixed(1)}ms   3 段/8 种形状: ${manyMs.toFixed(1)}ms`)
  console.log('    → 段数不是成本来源，注册过的形状数才是')
})

// ── maxListeners 的确切阈值 ──

test('maxListeners 警告在第 51 个订阅才出现，且消息里有数量和 key', () => {
  const bus = new EventBus()
  const warns = []
  bus.onError = (key, err) => warns.push({ key, msg: err.message })

  for (let i = 0; i < 50; i++) bus.listen('watched', () => {})
  assert.deepEqual(warns, [], '正好 50 个不警告 —— 阈值是「超过」不是「达到」')

  bus.listen('watched', () => {})
  assert.equal(warns.length, 1, '第 51 个触发第一条')
  assert.match(warns[0].msg, /51/, '消息里带真实数量')
  assert.match(warns[0].msg, /watched/, '带 key，否则不知道是哪个桶漏了')
  assert.match(warns[0].msg, /possible leak/)
  assert.equal(warns[0].key, 'watched', 'onError 的 key 参数也是那个桶')

  bus.listen('watched', () => {})
  assert.equal(warns.length, 2, '之后每加一个都再警告一次')
})

test('警告只是提醒，不阻止订阅也不影响派发', () => {
  const bus = new EventBus()
  bus.onError = () => {}
  let hits = 0
  for (let i = 0; i < 200; i++) bus.listen('many', () => hits++)
  bus.emit('many', {})
  assert.equal(hits, 200, '200 个全触发，一个不少')
})

test('通配符桶和精确桶各自计数，不合并', () => {
  const bus = new EventBus()
  const warns = []
  bus.onError = (_k, e) => warns.push(e.message)
  for (let i = 0; i < 40; i++) bus.listen('x:y', () => {})
  for (let i = 0; i < 40; i++) bus.listen('x:*', () => {})
  assert.deepEqual(warns, [], '两个桶各 40，都没过 50 —— 阈值是按桶算的')
})

// ── key 的退化形状 ──

test('空段、全空段、前后导冒号', () => {
  const bus = new EventBus()
  const got = []
  for (const p of ['a:', ':a', '::', 'a::b']) bus.listen(p, (_p, k) => got.push(k))

  bus.emit('a:', {})
  bus.emit(':a', {})
  bus.emit('::', {})
  bus.emit('a::b', {})
  assert.deepEqual(got, ['a:', ':a', '::', 'a::b'], '空段是合法的一段，字面匹配')

  // * 能匹配空段
  const wild = []
  bus.listen('a:*', (_p, k) => wild.push(k))
  bus.emit('a:', {})
  assert.deepEqual(wild, ['a:'], '* 匹配空串这一段')
})

test('单段 key（没有冒号）', () => {
  const bus = new EventBus()
  const got = []
  bus.listen('bare', (_p, k) => got.push(k))
  bus.listen('*', (_p, k) => got.push(`wild:${k}`))
  bus.emit('bare', {})
  assert.deepEqual(got.sort(), ['bare', 'wild:bare'], '单段也能用 * 订')
})

test('超长 key：1000 段', () => {
  const bus = new EventBus()
  const key = Array.from({ length: 1000 }, (_, i) => `s${i}`).join(':')
  let hit = 0
  bus.listen(key, () => hit++)
  bus.emit(key, {})
  assert.equal(hit, 1, '1000 段的精确匹配也走得通')
})

test('超长单段：100KB 的段名', () => {
  const bus = new EventBus()
  const key = `pre:${'z'.repeat(100 * 1024)}`
  let hit = 0
  bus.listen(key, () => hit++)
  bus.listen('pre:*', () => hit++)
  bus.emit(key, {})
  assert.equal(hit, 2, '段名多长都只是个字符串')
})

// ── 递归 emit ──

test('listen 的 cb 里 emit 同一个 key 会爆栈 —— 记录事实，不是保护', () => {
  // EventBus 对递归 emit 没有深度保护，和 Node 原生 EventEmitter 一致：递归是订阅者的 bug。
  // 栈溢出被 onError 兜住（异常隔离是有的），所以进程不死，但那一拍的派发废了。
  // 这条测试钉住现状：哪天加了深度闸，它会红，提醒改文档。
  const bus = new EventBus()
  const errs = []
  bus.onError = (_k, e) => errs.push(e.message)

  bus.listen('loop', () => bus.emit('loop', {}))
  assert.doesNotThrow(() => bus.emit('loop', {}), '爆栈被 onError 吃掉，不冒到调用方')
  assert.ok(errs.some(m => /call stack/i.test(m)), `栈溢出进了 onError，实得 ${errs[0]?.slice(0, 60)}`)
})

test('通配符自套也一样：listen(a:*) 里 emit(a:x)', () => {
  const bus = new EventBus()
  const errs = []
  bus.onError = (_k, e) => errs.push(e.message)
  bus.listen('a:*', () => bus.emit('a:x', {}))
  assert.doesNotThrow(() => bus.emit('a:x', {}))
  assert.ok(errs.some(m => /call stack/i.test(m)), '同一个 listener 自己命中自己')
})

test('listenOnce 递归是安全的 —— 自摘就是天然刹车', () => {
  const bus = new EventBus()
  let n = 0
  bus.listenOnce('once-loop', () => { n++; bus.emit('once-loop', {}) })
  assert.doesNotThrow(() => bus.emit('once-loop', {}))
  assert.equal(n, 1, '触发前已被摘掉，递归进去时桶里没它了')
})

test('两个 listener 互相 emit 也会爆栈', () => {
  const bus = new EventBus()
  const errs = []
  bus.onError = (_k, e) => errs.push(e.message)
  bus.listen('ping', () => bus.emit('pong', {}))
  bus.listen('pong', () => bus.emit('ping', {}))
  assert.doesNotThrow(() => bus.emit('ping', {}))
  assert.ok(errs.some(m => /call stack/i.test(m)), '跨 listener 的环，深度闸也拦不住的那种')
})

// ── 异步与顺序 ──

test('5000 个 async listener 全部 reject，onError 一条不漏', async () => {
  const bus = new EventBus()
  const rejects = [], warns = []
  // onError 是两路合流的：listener 抛错走这里，maxListeners 超标警告也走这里。
  // 按内容分开数 —— 5000 个订阅会顺带产生 4950 条泄漏警告（第 51 个起每加一个一条）。
  bus.onError = (_k, e) => (/possible leak/.test(e.message) ? warns : rejects).push(e.message)
  for (let i = 0; i < 5000; i++) bus.listen('boom', async () => { throw new Error(`e${i}`) })
  assert.equal(warns.length, 4950, '订阅阶段的警告数 = 5000 - maxListeners(50)')

  bus.emit('boom', {})
  await new Promise((r) => setImmediate(r))
  assert.equal(rejects.length, 5000, `5000 条 reject 全上报，实得 ${rejects.length}`)
  assert.equal(new Set(rejects).size, 5000, '每条都是不同的那一个，没有重复上报')
})

test('emit 期间大量增删订阅不影响本次派发的名单', () => {
  const bus = new EventBus()
  const ran = []
  const ids = []
  for (let i = 0; i < 100; i++) ids.push(bus.listen('churn', () => ran.push(i)))
  // 第一个 listener 把后面 99 个全摘掉，再加 100 个新的
  bus.listen('churn', () => {
    for (const id of ids) bus.off(id)
    for (let i = 0; i < 100; i++) bus.listen('churn', () => ran.push(`new${i}`))
  })

  bus.emit('churn', {})
  // 本次派发的名单在 emit 开始时就定了：100 个老的照跑，新加的一个都不跑
  assert.equal(ran.length, 100, `本次只跑快照里的 100 个，实得 ${ran.length}`)
  assert.ok(ran.every(v => typeof v === 'number'), '没有 new* 混进来')
})

test('asyncListenOnce 大量并发等待同一个 key', async () => {
  const bus = new EventBus()
  const waiters = Array.from({ length: 1000 }, (_, i) => bus.asyncListenOnce('gate', (p) => p.v + i))
  bus.emit('gate', { v: 0 })
  const got = await Promise.all(waiters)
  assert.deepEqual(got, Array.from({ length: 1000 }, (_, i) => i), '1000 个各自拿到自己 cb 的返回值')
})

// ── readonlyView 规模 ──

test('readonlyView 的读透传开销', async () => {
  const target = { a: 1, b: 2, get c() { return this.a + this.b } }
  const view = readonlyView(target)
  let sum = 0
  const [, ms] = await timed(async () => { for (let i = 0; i < 100000; i++) sum += view.c })
  assert.equal(sum, 300000)
  console.log(`    100000 次 proxy getter 读: ${ms.toFixed(1)}ms (${(ms / 100000 * 1000).toFixed(2)}µs/次)`)
})

test('嵌套 readonlyView 不会叠加保护', () => {
  const target = { deep: { deeper: { v: 1 } } }
  const view = readonlyView(target)
  // 浅层保护：第一层拦住，往下裸返回
  assert.throws(() => { view.deep = {} }, /readonly/)
  view.deep.deeper.v = 99
  assert.equal(target.deep.deeper.v, 99, '两层往下照样改得动')
})
