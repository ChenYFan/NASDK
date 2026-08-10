/**
 * simple/napp — 联测：一个完整 App 从装配到收工，跑通主流程。
 *
 * simple 里唯一起真网络的文件（其余五个是各层单测）。读这个文件学 NASDK 怎么用。
 * 不用任何共享 helper，从头写到尾。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import NApp from '../../index.ts'
import { NACEB, PipelineHandler, TaskHandler } from '../../NACEB/index.ts'
import { NACAB } from '../../NACAB/index.ts'

const PORT = 18900

// ── 业务代码：一个 Task、一条 Pipeline、一个 Ability ──

class CountDown extends TaskHandler {
  name = 'countDown'
  description = '从 n 数到 0，每步上报一次'
  async execute() {
    this.processingResultReport({ at: this.input })   // 显式上报，请求方的 onProcess 才收得到
    return this.input - 1
  }
}

class CountDownPipe extends PipelineHandler {
  name = 'countDownPipe'
  description = '数到 0 为止'
  next(lastResult) {
    if (lastResult === undefined) return { task: 'countDown', input: this.event.payload.from }
    if (lastResult <= 0) return { task: '$terminal', input: { reached: 0 } }
    return { task: 'countDown', input: lastResult }
  }
}

test('simple/napp：一次完整往返', async (t) => {
  // ── 装配服务端 ──
  const naceb = new NACEB({
    pipelineHandlers: [new CountDownPipe()],
    taskHandlers: [new CountDown()],
    eventAlias: [{ eventName: 'countdown', pipelineName: 'countDownPipe', description: '数到 0' }],
  })
  const nacab = new NACAB()
  nacab.register({ name: 'math.add', description: '两数相加', execute: (p) => p.a + p.b })

  const server = new NApp({
    id: 'core',
    server: [{ type: 'tcp', opt: { ip: '127.0.0.1', port: PORT } }],
  })
  server.bindProcessor('event', naceb.nacpAdaptor)      // 必须在 start() 之前绑
  server.bindProcessor('ability', nacab.nacpAdaptor)
  await server.start()                                  // 到这里才开始监听

  // 客户端不写 server[]，但同样要 start()
  const client = new NApp({ id: 'web' })
  await client.start()

  await t.test('connect 建立双向连接', async () => {
    await client.connect('core', { type: 'tcp', opt: { ip: '127.0.0.1', port: PORT } })
    assert.deepEqual(client.listConnectedApp(), ['core'])
    assert.deepEqual(server.listConnectedApp(), ['web'])
  })

  await t.test('Ability：一问一答', async () => {
    const res = await client.request('core', { kind: 'ability', target: 'math.add', payload: { a: 20, b: 22 } })
    assert.equal(res.payload, 42)
  })

  await t.test('Event：过程流实时回来，await 到的是终结结果', async () => {
    const seen = []
    const res = await client.request('core', {
      kind: 'event', target: 'countdown', payload: { from: 3 },
      onProcess: (chunk) => seen.push(chunk.at),
    })
    assert.deepEqual(seen, [3, 2, 1])
    assert.deepEqual(res.payload, { reached: 0 })
  })

  await t.test('失败是 reject，不是返回一条失败响应', async () => {
    await assert.rejects(
      client.request('core', { kind: 'ability', target: '不存在', payload: {} }),
      (e) => e.code === 'response-not-ok',
    )
  })

  await t.test('subscribe：远程订阅对端的 bus', async () => {
    const [sub, stream] = client.subscribe('core', 'demo:*')

    // 流返回时就是活的，所以这两条不会漏
    server.bus.emit('demo:hello', { n: 1 })
    server.bus.emit('demo:world', { n: 2 })

    const got = []
    for await (const chunk of stream) {
      got.push(chunk.n)
      if (got.length === 2) break                       // break == 主动退订
    }
    assert.deepEqual(got, [1, 2])

    const res = await sub
    assert.equal(res.meta.isOk, true)
    assert.equal(typeof res.payload.targetSubId, 'string')   // 退订要的 id 在这
  })

  await t.test('disconnect 只断一个对端，App 还活着，还能连回来', async () => {
    assert.equal(await client.disconnect('core'), true)
    assert.deepEqual(client.listConnectedApp(), [])
    await client.connect('core', { type: 'tcp', opt: { ip: '127.0.0.1', port: PORT } })
    assert.deepEqual(client.listConnectedApp(), ['core'])
  })

  // terminate 是 start 的反面
  await client.terminate()
  await server.terminate()
})

test('simple/napp：三种 carrier 都能跑同一套调用', async (t) => {
  for (const [name, spec] of [
    ['tcp', { type: 'tcp', opt: { ip: '127.0.0.1', port: PORT + 1 } }],
    ['ws', { type: 'ws', opt: { ip: '127.0.0.1', port: PORT + 2, path: '/ws' } }],
    ['unix', { type: 'unix', opt: { socketPath: `/tmp/nasdk-simple-${process.pid}.sock` } }],
  ]) {
    await t.test(name, async () => {
      const nacab = new NACAB()
      nacab.register({ name: 'ping', description: 'ping', execute: () => 'pong' })
      const srv = new NApp({ id: 'srv', server: [spec] })
      srv.bindProcessor('ability', nacab.nacpAdaptor)
      await srv.start()

      const cli = new NApp({ id: 'cli' })
      await cli.start()
      await cli.connect('srv', spec)

      const res = await cli.request('srv', { kind: 'ability', target: 'ping', payload: {} })
      assert.equal(res.payload, 'pong')

      await cli.terminate()
      await srv.terminate()
    })
  }
})
