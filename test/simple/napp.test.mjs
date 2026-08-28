/**
 * simple/napp — 联测：两个 App、两个进程，跑通主流程。
 *
 * simple 里唯一起真网络的文件（其余五个是各层单测）。读这个文件学 NASDK 怎么用。
 *
 * 服务端在 ./_server.mjs，由 fork 起在独立进程里 —— 两个 App 本来就该分处两个进程，同进程扮演两端会让
 * 测试写出真实部署下不可能的操作（直接 emit 到对端的 bus）。
 *
 *   node --import tsx --test test/simple/napp.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import NApp from '../../index.ts'

const SERVER = fileURLToPath(new URL('./_server.mjs', import.meta.url))
const PORT = 18900

/** 起服务端子进程，等它 ready。返回子进程句柄 + 一个 ask()（请它做事并等回话）。 */
async function startServer(specs) {
  const child = fork(SERVER, [JSON.stringify(specs)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`服务端子进程提前退出，code=${code}`)))
  })
  return {
    child,
    /** 请对端在它自己的 bus 上 emit —— 真实拓扑下只能这样，不能从外部戳它的 bus。 */
    emit: (key, payload) => child.send({ cmd: 'emit', key, payload }),
    ask: (cmd) => new Promise((r) => { child.once('message', r); child.send({ cmd }) }),
    stop: async () => {
      child.send({ cmd: 'bye' })
      await new Promise((r) => child.once('exit', r))
    },
  }
}

test('simple/napp：一次完整往返', async (t) => {
  const spec = { type: 'tcp', opt: { ip: '127.0.0.1', port: PORT } }
  const server = await startServer([spec])

  // 客户端不写 server[]，但同样要 start()
  const client = new NApp({ id: 'web' })
  await client.start()

  await t.test('connect 建立双向连接', async () => {
    await client.connect('core', spec)
    assert.deepEqual(client.listConnectedApp(), ['core'])
    assert.deepEqual((await server.ask('peers')).peers, ['web'])
  })

  await t.test('Ability：一问一答', async () => {
    const res = await client.request('core', { kind: 'ability', target: 'math.add', payload: { a: 20, b: 22 } }).response
    assert.equal(res.payload, 42)
  })

  await t.test('Event：过程流实时回来，await 到的是终结结果', async () => {
    const seen = []
    const res = await client.request('core', {
      kind: 'event', target: 'countdown', payload: { from: 3 },
      onProcess: (message) => seen.push(message.payload.at),
    }).response
    assert.deepEqual(seen, [3, 2, 1])
    assert.deepEqual(res.payload, { reached: 0 })
  })

  await t.test('失败是 reject，不是返回一条失败响应', async () => {
    await assert.rejects(
      client.request('core', { kind: 'ability', target: '不存在', payload: {} }).response,
      (e) => e.code === 'response-not-ok',
    )
  })

  await t.test('subscribe：远程订阅对端的 bus', async () => {
    const { subId, response, stream } = client.subscribe('core', 'demo:*')
    const res = await response                 // 等对端确认订阅已建立
    assert.equal(res.meta.isOk, true)
    assert.equal(res.payload.targetSubId, subId)

    server.emit('demo:hello', { n: 1 })        // 请对端自己发
    server.emit('demo:world', { n: 2 })

    const got = []
    for await (const message of stream) {
      got.push(message.payload.n)
      if (got.length === 2) break              // break == 主动退订
    }
    assert.deepEqual(got, [1, 2])
  })

  await t.test('disconnect 只断一个对端，App 还活着，还能连回来', async () => {
    assert.equal(await client.disconnect('core'), true)
    assert.deepEqual(client.listConnectedApp(), [])
    await client.connect('core', spec)
    assert.deepEqual(client.listConnectedApp(), ['core'])
  })

  await client.terminate()                     // terminate 是 start 的反面
  await server.stop()
})

test('simple/napp：一个 App 同开三种 carrier，调用写法完全一样', async (t) => {
  const specs = [
    { type: 'tcp', opt: { ip: '127.0.0.1', port: PORT + 1 } },
    { type: 'ws', opt: { ip: '127.0.0.1', port: PORT + 2, path: '/ws' } },
    { type: 'unix', opt: { socketPath: `/tmp/nasdk-simple-${process.pid}.sock` } },
  ]
  const server = await startServer(specs)

  for (const spec of specs) {
    await t.test(spec.type, async () => {
      const cli = new NApp({ id: `cli-${spec.type}` })
      await cli.start()
      await cli.connect('core', spec)          // 只有这一行随 carrier 变
      const res = await cli.request('core', { kind: 'ability', target: 'math.add', payload: { a: 1, b: 2 } }).response
      assert.equal(res.payload, 3)
      await cli.terminate()
    })
  }

  await server.stop()
})
