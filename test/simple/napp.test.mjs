// Two real processes run the full NASDK flow over real networks.
// Same-process both-sides would allow poking the peer's bus directly, impossible in real deployment.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import NApp from '../../index.ts'
import TCPClientProvider from '../../packages/nact-tcp-client/index.ts'
import UnixClientProvider from '../../packages/nact-unix-client/index.ts'
import WebSocketClientProvider from '../../packages/nact-websocket-client/index.ts'
import { sock } from '../_kit.mjs'

const SERVER = fileURLToPath(new URL('../_kit.mjs', import.meta.url))
const PORT = 18900
const clientProviders = {
  tcp: () => new TCPClientProvider(),
  unix: () => new UnixClientProvider(),
  websocket: () => new WebSocketClientProvider(),
}

/** Fork server child, wait for ready, return handle with ask(). */
async function startServer(specs) {
  const child = fork(SERVER, ['--test-peer', 'simple', JSON.stringify(specs)], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`服务端子进程提前退出，code=${code}`)))
  })
  return {
    child,
    /** Ask the peer to emit on its own bus; a real topology offers no other way. */
    emit: (key, payload) => child.send({ cmd: 'emit', key, payload }),
    ask: (cmd) => new Promise((r) => { child.once('message', r); child.send({ cmd }) }),
    stop: async () => {
      child.send({ cmd: 'bye' })
      await new Promise((r) => child.once('exit', r))
    },
  }
}

test('simple/napp：一次完整往返', async (t) => {
  const serverSpec = { type: 'tcp', provider: { host: '127.0.0.1', port: PORT } }
  const clientSpec = { type: 'tcp', provider: { host: '127.0.0.1', port: PORT } }
  const server = await startServer([serverSpec])

  // client omits server[] but still must start()
  const client = new NApp({ id: 'web' })
  client.nact.use(new TCPClientProvider())
  await client.start()

  await t.test('connect 建立双向连接', async () => {
    await client.connect('core', clientSpec)
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
    const res = await response                 // wait for subscribe confirmation
    assert.equal(res.meta.isOk, true)
    assert.equal(res.payload.targetSubId, subId)

    server.emit('demo:hello', { n: 1 })        // ask peer to emit on its own bus
    server.emit('demo:world', { n: 2 })

    const got = []
    for await (const message of stream) {
      got.push(message.payload.n)
      if (got.length === 2) break              // break == unsubscribe
    }
    assert.deepEqual(got, [1, 2])
  })

  await t.test('disconnect 只断一个对端，App 还活着，还能连回来', async () => {
    assert.equal(await client.disconnect('core'), true)
    assert.deepEqual(client.listConnectedApp(), [])
    await client.connect('core', clientSpec)
    assert.deepEqual(client.listConnectedApp(), ['core'])
  })

  await client.terminate()
  await server.stop()
})

test('simple/napp：一个 App 同开三种 carrier，调用写法完全一样', async (t) => {
  const entries = [
    {
      server: { type: 'tcp', provider: { host: '127.0.0.1', port: PORT + 1 } },
      client: { type: 'tcp', provider: { host: '127.0.0.1', port: PORT + 1 } },
    },
    {
      server: { type: 'websocket', provider: { host: '127.0.0.1', port: PORT + 2, path: '/ws' } },
      client: { type: 'websocket', provider: { url: `ws://127.0.0.1:${PORT + 2}/ws` } },
    },
    {
      server: { type: 'unix', provider: { path: sock('simple') } },
      client: { type: 'unix', provider: { path: sock('simple') } },
    },
  ]
  const server = await startServer(entries.map(entry => entry.server))

  for (const entry of entries) {
    await t.test(entry.client.type, async () => {
      const cli = new NApp({ id: `cli-${entry.client.type}` })
      cli.nact.use(clientProviders[entry.client.type]())
      await cli.start()
      await cli.connect('core', entry.client)
      const res = await cli.request('core', { kind: 'ability', target: 'math.add', payload: { a: 1, b: 2 } }).response
      assert.equal(res.payload, 3)
      await cli.terminate()
    })
  }

  await server.stop()
})
