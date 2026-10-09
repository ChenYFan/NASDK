import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventBus, readonlyView } from '../../EventBus.ts'
import { timed } from '../_kit.mjs'

// ── scale ──

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
  bus.onError = () => {}              // swallow maxListeners warnings
  let hits = 0
  for (let i = 0; i < 5000; i++) bus.listen('same', () => hits++)

  const [, ms] = await timed(async () => bus.emit('same', {}))
  assert.equal(hits, 5000)
  console.log(`    5000 listener 单次 emit: ${ms.toFixed(1)}ms`)
})

test('派发成本取决于「注册过几种形状」，而不是 key 有几段', async () => {
  // Cost scales with registered shape count, not key segment count.
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

// ── maxListeners threshold ──

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

// ── degenerate keys ──

test('空段、全空段、前后导冒号', () => {
  const bus = new EventBus()
  const got = []
  for (const p of ['a:', ':a', '::', 'a::b']) bus.listen(p, (_p, k) => got.push(k))

  bus.emit('a:', {})
  bus.emit(':a', {})
  bus.emit('::', {})
  bus.emit('a::b', {})
  assert.deepEqual(got, ['a:', ':a', '::', 'a::b'], '空段是合法的一段，字面匹配')

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

// ── recursive emit ──

test('listen 的 cb 里 emit 同一个 key 会爆栈 —— 记录事实，不是保护', () => {
  // No recursion guard; stack overflow lands in onError, matching Node's EventEmitter.
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

// ── async & ordering ──

test('5000 个 async listener 全部 reject，onError 一条不漏', async () => {
  const bus = new EventBus()
  const rejects = [], warns = []
  // onError carries both listener errors and maxListeners warnings; split by content.
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
  // First listener removes the other 99 and adds 100 new ones mid-emit.
  bus.listen('churn', () => {
    for (const id of ids) bus.off(id)
    for (let i = 0; i < 100; i++) bus.listen('churn', () => ran.push(`new${i}`))
  })

  bus.emit('churn', {})
  // Dispatch list is snapshotted at emit start: old 100 run, new ones don't.
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

// ── readonlyView scale ──

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
  // Shallow guard: first level only.
  assert.throws(() => { view.deep = {} }, /readonly/)
  view.deep.deeper.v = 99
  assert.equal(target.deep.deeper.v, 99, '两层往下照样改得动')
})
