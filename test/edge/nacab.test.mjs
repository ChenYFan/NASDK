/**
 * edge/nacab — 临界值与压力。
 *
 * full/nacab 覆盖正常路径，这里挑规模与退化：大量并发 invoke（NACAB 契约上无并发上限）、
 * 大 payload、handler 的各种非常规返回、能力名的退化形状、观测面在高频下的开销。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NACAB } from '../../NACAB/index.ts'
import { NACABError } from '../../NACAB/errors.ts'
import { collect, timed, rate, sleep } from '../_kit.mjs'

// ── 并发规模 ──

test('5000 次并发 invoke：无上限是契约，全部完成且互不串', async () => {
  // "NACAB 和 NACEB 的 AsyncTask 被设计为绝对能够并发启动，没有设置上限" —— README
  const nacab = new NACAB()
  nacab.register({ name: 'id', description: 'x', execute: async (p) => { await sleep(1); return p.i } })

  const N = 5000
  const [got, ms] = await timed(() => Promise.all(Array.from({ length: N }, (_, i) => nacab.invoke('id', { i }))))
  assert.deepEqual(got, Array.from({ length: N }, (_, i) => i), '每次拿回自己的入参，没有串')
  console.log(`    ${N} 并发 invoke: ${ms.toFixed(0)}ms (${(N / (ms / 1000)).toFixed(0)} inv/s)`)
})

test('5000 次并发后内部表不增长 —— 无实例泄漏', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  nacab.register({ name: 'bad', description: 'x', execute: () => { throw new Error('x') } })

  await Promise.all([
    ...Array.from({ length: 2500 }, () => nacab.invoke('ok', {})),
    ...Array.from({ length: 2500 }, () => nacab.invoke('bad', {}).catch(() => {})),
  ])

  const maps = Object.getOwnPropertyNames(nacab)
    .map(k => [k, nacab[k]?.size]).filter(([, v]) => typeof v === 'number')
  assert.deepEqual(maps, [['handlers', 2]], `只剩 handlers 表，实得 ${JSON.stringify(maps)}`)
})

test('一半成功一半失败并发，两边都不影响对方', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: async (p) => { await sleep(1); return p.i } })
  nacab.register({ name: 'bad', description: 'x', execute: async (p) => { await sleep(1); throw new Error(`e${p.i}`) } })

  const settled = await Promise.allSettled(
    Array.from({ length: 2000 }, (_, i) => nacab.invoke(i % 2 ? 'bad' : 'ok', { i })),
  )
  const ok = settled.filter(s => s.status === 'fulfilled')
  const no = settled.filter(s => s.status === 'rejected')
  assert.equal(ok.length, 1000)
  assert.equal(no.length, 1000)
  assert.deepEqual(ok.map(s => s.value).sort((a, b) => a - b), Array.from({ length: 1000 }, (_, i) => i * 2))
  assert.ok(no.every((s, i) => s.reason.message === `e${i * 2 + 1}`), '每个失败带的是自己的错')
})

// ── 大 payload ──

test('1MB payload 进出 execute，字节级一致', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'echo', description: 'x', execute: (p) => p })
  const big = 'X'.repeat(1024 * 1024)
  const [out, ms] = await timed(() => nacab.invoke('echo', { big }))
  assert.equal(out.big, big, 'NACAB 不碰 payload，原样进原样出')
  console.log(`    ${rate('1MB through invoke', big.length, ms)}`)
})

test('1MB 二进制不被序列化污染', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'echo', description: 'x', execute: (p) => p })
  const bin = new Uint8Array(1024 * 1024)
  bin[0] = 1; bin[bin.length - 1] = 255
  const out = await nacab.invoke('echo', { bin })
  assert.equal(out.bin, bin, '同一个对象引用 —— NACAB 层内不做拷贝')
})

// ── handler 的退化返回 ──

test('execute 返回各种非常规值都原样传出', async () => {
  const nacab = new NACAB()
  const cases = [
    ['undefined', undefined], ['null', null], ['zero', 0], ['emptyStr', ''],
    ['false', false], ['NaN', NaN], ['inf', Infinity], ['negZero', -0],
    ['bigint', 10n ** 20n], ['sym', Symbol.for('s')], ['fn', () => 1],
  ]
  for (const [name, v] of cases) nacab.register({ name, description: 'x', execute: () => v })

  for (const [name, v] of cases) {
    const got = await nacab.invoke(name, {})
    if (Number.isNaN(v)) assert.ok(Number.isNaN(got), name)
    else assert.equal(got, v, name)
  }
})

test('execute 抛非 Error：字符串 / 数字 / null / 对象', async () => {
  const nacab = new NACAB()
  const thrown = ['字符串', 42, null, undefined, { code: 'x' }, Symbol.for('boom')]
  thrown.forEach((v, i) => nacab.register({ name: `t${i}`, description: 'x', execute: () => { throw v } }))

  for (let i = 0; i < thrown.length; i++) {
    await assert.rejects(() => nacab.invoke(`t${i}`, {}), (e) => {
      assert.equal(e, thrown[i], `抛出的原物照样抛出（第 ${i} 个）`)
      return true
    })
  }
})

test('execute 抛非 Error 时，failure:after 的视图上 error 也是原物', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'weird', description: 'x', execute: () => { throw '光秃秃的字符串' } })
  let seen
  nacab.eventBusObs.listen('nacab:ability:failure:after:*', function () { seen = this.error })
  await nacab.invoke('weird', {}).catch(() => {})
  assert.equal(seen, '光秃秃的字符串')
})

test('execute 返回 rejected promise 与 throw 等价', async () => {
  const nacab = new NACAB()
  const boom = new Error('rejected')
  nacab.register({ name: 'rej', description: 'x', execute: () => Promise.reject(boom) })
  await assert.rejects(() => nacab.invoke('rej', {}), (e) => e === boom)
})

test('execute 返回 pending 永不 settle 的 promise → invoke 也永不 settle', async () => {
  // NACAB 无超时设计：一次能力调用多久算超时是业务的事。这条钉住「框架不会替你兜」。
  const nacab = new NACAB()
  nacab.register({ name: 'never', description: 'x', execute: () => new Promise(() => {}) })
  const race = await Promise.race([nacab.invoke('never', {}), sleep(150).then(() => 'STILL-PENDING')])
  assert.equal(race, 'STILL-PENDING', 'NACAB 不加超时，挂着就是挂着')
})

// ── 能力名的退化形状 ──

test('能力名可以是任何非空字符串 —— NACAB 不解释名字', async () => {
  const nacab = new NACAB()
  const names = [
    'a', '带.点', '带:冒号', '中文能力', 'with space', 'emoji🎉',
    '$dollar', '__proto__', 'constructor', 'toString',
    'x'.repeat(10000),
  ]
  for (const n of names) nacab.register({ name: n, description: 'x', execute: () => n })
  for (const n of names) assert.equal(await nacab.invoke(n, {}), n, `名字 ${n.slice(0, 20)}`)
  assert.equal(nacab.listAbility().length, names.length, '每个名字一行，没有互相覆盖')
})

test('__proto__ / constructor 这类名字不污染原型', async () => {
  // handlers 是 Map 而不是普通对象，所以这些名字只是普通 key。
  const nacab = new NACAB()
  nacab.register({ name: '__proto__', description: 'x', execute: () => 'proto-handler' })
  assert.equal(await nacab.invoke('__proto__', {}), 'proto-handler')
  assert.equal({}.polluted, undefined, '没有污染到 Object.prototype')
  assert.equal(Object.prototype.polluted, undefined)
})

test('未知能力的报错带上被找的那个名字', async () => {
  const nacab = new NACAB()
  await assert.rejects(() => nacab.invoke('查无此名', {}), (e) => {
    assert.ok(e instanceof NACABError)
    assert.equal(e.code, 'unknown-ability')
    assert.equal(e.phase, 'inbound')
    assert.match(e.message, /查无此名/, '报错里要有名字，否则没法查')
    return true
  })
})

test('2000 个能力注册后 listAbility 与 invoke 都正常', async () => {
  const nacab = new NACAB()
  const [, regMs] = await timed(async () => {
    for (let i = 0; i < 2000; i++) nacab.register({ name: `ab${i}`, description: `d${i}`, execute: () => i })
  })
  assert.equal(nacab.listAbility().length, 2000)
  const [, invMs] = await timed(() => Promise.all([0, 999, 1999].map(i => nacab.invoke(`ab${i}`, {}))))
  console.log(`    2000 次 register: ${regMs.toFixed(1)}ms;  3 次查表 invoke: ${invMs.toFixed(2)}ms`)
})

// ── 观测面在高频下 ──

test('高频 invoke 时观测面事件数正比于调用数', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 1 })
  const tEvents = collect(nacab.eventBus, 'nacab:ability:*:*:*')
  const logs = collect(nacab.eventBus, 'nacab:runtime:log:*')

  const N = 500
  await Promise.all(Array.from({ length: N }, () => nacab.invoke('ok', {})))
  tEvents.stop(); logs.stop()

  assert.equal(tEvents.events.length, N * 4, '每次 4 条 T 事件（running/done 各 before+after）')
  assert.equal(logs.events.length, N * 2, '每次 2 条 log（invoke + done）')
  assert.equal(new Set(tEvents.events.map(e => e.hitKey.split(':')[4])).size, N, `${N} 个不同的实例 id`)
})

test('挂 100 个观测者时 invoke 仍不受影响', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 'result' })
  nacab.eventBus.onError = () => {}                       // 吃掉 maxListeners 警告
  let fired = 0
  for (let i = 0; i < 100; i++) nacab.eventBusObs.listen('nacab:ability:done:after:*', () => fired++)

  const [got, ms] = await timed(() => nacab.invoke('ok', {}))
  assert.equal(got, 'result')
  assert.equal(fired, 100, '100 个观测者全触发')
  console.log(`    100 个观测者下单次 invoke: ${ms.toFixed(2)}ms`)
})

test('每个观测者都抛异常也不影响 invoke 与彼此', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'ok', description: 'x', execute: () => 'result' })
  const busErrs = collect(nacab.eventBus, 'nacab:runtime:error:bus')
  let ran = 0
  for (let i = 0; i < 50; i++) {
    nacab.eventBusObs.listen('nacab:ability:done:after:*', () => { ran++; throw new Error(`obs${i}`) })
  }

  assert.equal(await nacab.invoke('ok', {}), 'result', 'invoke 照常返回')
  busErrs.stop()
  assert.equal(ran, 50, '50 个观测者全跑到，前面抛错不截断后面')
  assert.equal(busErrs.events.length, 50, '50 条都进了 error:bus')
})

// ── adaptor 压力 ──

test('adaptor.push 5000 次并发，回调各归各位', async () => {
  const nacab = new NACAB()
  nacab.register({ name: 'id', description: 'x', execute: async (p) => { await sleep(1); return p.i } })

  const N = 5000
  const [got, ms] = await timed(() => Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve) => {
    nacab.nacpAdaptor.push({ target: 'id', payload: { i }, reqId: `r${i}` },
      { onProcess: () => assert.fail('能力没有过程流'), onResponse: (r, isOk) => resolve({ r, isOk }) })
  }))))

  assert.deepEqual(got.map(g => g.r), Array.from({ length: N }, (_, i) => i), '每个 reqId 的回调拿到自己的结果')
  assert.ok(got.every(g => g.isOk), '全部 isOk')
  console.log(`    ${N} 并发 adaptor.push: ${ms.toFixed(0)}ms`)
})
