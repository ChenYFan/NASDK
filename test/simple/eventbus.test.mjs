/**
 * simple/eventbus — NASDK 自带的事件总线，读这个文件学它怎么用。
 *
 * EventBus 是根级构件，不属于任何一层：NApp/NACP/NACT 共用一个（`app.bus`），NACEB/NACAB 各有自己的。
 * 它和 Node 的 EventEmitter 最大的两处不同：通配符订阅，和 `asyncListenOnce` 可以 await 一个事件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventBus } from '../../EventBus.ts'

test('listen / emit：最基本的一对', () => {
  const bus = new EventBus()
  const got = []
  bus.listen('job:done', (payload) => got.push(payload))

  bus.emit('job:done', { id: 1 })
  bus.emit('job:done', { id: 2 })

  assert.deepEqual(got, [{ id: 1 }, { id: 2 }])
})

test('listen 返回 listenId，off 用它取消', () => {
  const bus = new EventBus()
  const got = []
  const id = bus.listen('tick', () => got.push('x'))

  bus.emit('tick')
  assert.equal(bus.off(id), true)      // 取消成功返 true
  bus.emit('tick')                      // 这条不会再进回调

  assert.equal(got.length, 1)
  assert.equal(bus.off(id), false)      // 重复 off 返 false，不抛
})

test('listenOnce：只听一次，自动摘掉', () => {
  const bus = new EventBus()
  let n = 0
  bus.listenOnce('boot', () => { n++ })

  bus.emit('boot')
  bus.emit('boot')

  assert.equal(n, 1)
})

test('通配符 *：一段一个星，订一整族事件', () => {
  const bus = new EventBus()
  const hits = []
  // `*` 只匹配一个冒号段，所以 'naceb:task:*' 命中 'naceb:task:done' 而不是 'naceb:task:done:after'
  bus.listen('naceb:task:*', (p) => hits.push(p.what))

  bus.emit('naceb:task:done', { what: 'done' })
  bus.emit('naceb:task:failure', { what: 'failure' })
  bus.emit('naceb:event:done', { what: '不该命中' })      // 第二段不同
  bus.emit('naceb:task:done:after', { what: '不该命中' })  // 段数不同，* 不跨段

  assert.deepEqual(hits.sort(), ['done', 'failure'])
})

test('回调第二个参数是实际命中的 key —— 通配符订阅者靠它分辨catch到了什么', () => {
  const bus = new EventBus()
  const hits = []
  bus.listen('job:*', (payload, hitKey) => hits.push(hitKey))

  bus.emit('job:done', {})
  bus.emit('job:failed', {})

  // 只有模式的话分不出这两个。NACP 的 notify 因此在 meta 里同时带
  // targetSubName（订的模式）和 hitSubName（命中的具体名），跨进程后者才不丢。
  assert.deepEqual(hits, ['job:done', 'job:failed'])
})

test('asyncListenOnce：await 一个事件', async () => {
  const bus = new EventBus()

  setTimeout(() => bus.emit('ready', { port: 8080 }), 10)
  const payload = await bus.asyncListenOnce('ready')

  assert.deepEqual(payload, { port: 8080 })
})

test('emit 可以带 thisArg：回调里的 this 就是它', () => {
  const bus = new EventBus()
  const instance = { id: 'task-1', status: 'done' }
  let seen

  // NACEB/NACAB 的 T 事件就是这么发的：payload 为空，对象骑在 this 上
  bus.listen('demo:t', function () { seen = { id: this.id, status: this.status } })
  bus.emit('demo:t', undefined, instance)

  assert.deepEqual(seen, { id: 'task-1', status: 'done' })
})

test('一个观测者抛异常不会打断其他观测者', () => {
  const bus = new EventBus()
  const errors = []
  bus.onError = (key, err) => errors.push({ key, msg: err.message })

  const got = []
  bus.listen('x', () => { throw new Error('第一个炸了') })
  bus.listen('x', () => got.push('第二个照常跑'))

  bus.emit('x')

  assert.deepEqual(got, ['第二个照常跑'])
  assert.equal(errors.length, 1)
  assert.equal(errors[0].msg, '第一个炸了')
})

test('readonly：给外部的只读观测口，没有 emit', () => {
  const bus = new EventBus()
  const obs = bus.readonly

  // 能订阅
  const got = []
  obs.listen('y', (p) => got.push(p))
  bus.emit('y', 1)
  assert.deepEqual(got, [1])

  // 但发不出去 —— NACEB/NACAB 就是用这个把自己的 bus 暴露出去而不让人伪造事件
  assert.equal(obs.emit, undefined)
})
