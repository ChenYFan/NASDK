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
  assert.equal(bus.off(id), true)
  bus.emit('tick')                      // no callback after off

  assert.equal(got.length, 1)
  assert.equal(bus.off(id), false)      // second off returns false, no throw
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
  // `*` matches exactly one colon segment: 'naceb:task:*' hits 'naceb:task:done' only
  bus.listen('naceb:task:*', (p) => hits.push(p.what))

  bus.emit('naceb:task:done', { what: 'done' })
  bus.emit('naceb:task:failure', { what: 'failure' })
  bus.emit('naceb:event:done', { what: '不该命中' })
  bus.emit('naceb:task:done:after', { what: '不该命中' })

  assert.deepEqual(hits.sort(), ['done', 'failure'])
})

test('回调第二个参数是实际命中的 key —— 通配符订阅者靠它分辨catch到了什么', () => {
  const bus = new EventBus()
  const hits = []
  bus.listen('job:*', (payload, hitKey) => hits.push(hitKey))

  bus.emit('job:done', {})
  bus.emit('job:failed', {})

  // NACP notify carries targetSubName and hitSubName in meta so the hit name survives IPC
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

  // NACEB/NACAB T events ride the object on this, payload is empty
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

  const got = []
  obs.listen('y', (p) => got.push(p))
  bus.emit('y', 1)
  assert.deepEqual(got, [1])

  // no emit: NACEB/NACAB expose their bus this way without allowing event forgery
  assert.equal(obs.emit, undefined)
})
