/**
 * full/napp — 联测。真进程、真 socket，覆盖门面正常会走到的路径。
 *
 * 各层单测在 full/{nacp,nact,naceb,nacab,eventbus}；这个文件只测「装起来之后端到端是否成立」。
 * 对端跑在 ./_peer.mjs 的独立进程里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import NApp from '../../index.ts'
import { NACEB } from '../../NACEB/index.ts'
import { NACAB } from '../../NACAB/index.ts'
import { PORT, tcp, ws, unix, sock, startApp, makeNaceb, makeNacab, collect, sleep } from '../_kit.mjs'

const PEER = fileURLToPath(new URL('./_peer.mjs', import.meta.url))

/** 起一个对端进程。返回 ask()（发命令等回话）和 stop()。 */
async function spawnPeer(cfg) {
  const child = fork(PEER, [JSON.stringify(cfg)], {
    execArgv: ['--experimental-strip-types'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (c) => reject(new Error(`对端进程提前退出 code=${c}`)))
  })
  let seq = 0
  const ask = (cmd, extra = {}) => new Promise((resolve) => {
    const id = ++seq
    const onMsg = (m) => { if (m.id === id) { child.off('message', onMsg); resolve(m) } }
    child.on('message', onMsg)
    child.send({ cmd, id, ...extra })
  })
  return {
    child, ask,
    emit: (key, payload) => ask('emit', { key, payload }),
    stop: async () => {
      if (child.exitCode !== null) return
      child.send({ cmd: 'bye' })
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 2000) })
    },
  }
}

// ── 装配 ──

test('两个 kind 都不绑也能 start —— 自动兜默认 Processor', async () => {
  const app = new NApp({ id: 'bare' })
  await app.start()

  assert.ok(app.default.NACEB instanceof NACEB, '空缺的 event 侧兜了 NACEB')
  assert.ok(app.default.NACAB instanceof NACAB, '空缺的 ability 侧兜了 NACAB')
  assert.ok(app.getProcessor('event'), 'getProcessor 查得到')
  assert.ok(app.getProcessor('ability'))
  await app.terminate()
})

test('自己绑了就不兜，app.default 保持空', async () => {
  const app = new NApp({ id: 'own' })
  app.bindProcessor('event', makeNaceb().nacpAdaptor)
  app.bindProcessor('ability', makeNacab().nacpAdaptor)
  await app.start()

  assert.equal(app.default.NACEB, undefined)
  assert.equal(app.default.NACAB, undefined)
  await app.terminate()
})

test('bindProcessor 绑 ability 时注入 NApp 自己的能力', async () => {
  const app = new NApp({ id: 'x' })
  const nacab = new NACAB()
  assert.deepEqual(nacab.listAbility(), [], '绑之前是空的')

  app.bindProcessor('ability', nacab.nacpAdaptor)
  assert.ok(nacab.listAbility().some(a => a.name === 'NApp.introduce'), '绑的时候注进去了')
  await app.terminate()
})

test('绑一个自制 Processor 也行 —— NACP 只认契约', async () => {
  const calls = []
  const custom = {
    list: () => [{ name: 'custom.thing', description: '自制' }],
    push: (spec, hooks) => { calls.push(spec.target); hooks.onResponse({ from: 'custom' }, true) },
    register: (item) => calls.push(`register:${item.name}`),
  }
  const app = new NApp({ id: 'c', server: [tcp(PORT.nappC)] })
  app.bindProcessor('ability', custom)
  await app.start()

  assert.ok(calls.includes('register:NApp.introduce'), '走契约的 register 口注入了 NApp 的能力')
  assert.ok(app.buildDecl().abilities.some(a => a.name === 'custom.thing'), '声明里有它')

  const cli = await startApp('cli-c')
  await cli.app.connect('c', tcp(PORT.nappC))
  const res = await cli.app.request('c', { kind: 'ability', target: 'custom.thing', payload: {} })
  assert.deepEqual(res.payload, { from: 'custom' })

  await cli.stop()
  await app.terminate()
})

test('buildDecl 从 Processor 现算；显式 decl 覆盖它', async () => {
  const app = new NApp({ id: 'd' })
  app.bindProcessor('event', makeNaceb().nacpAdaptor)
  app.bindProcessor('ability', makeNacab().nacpAdaptor)
  await app.start()
  const decl = app.buildDecl()
  assert.ok(decl.events.some(e => e.name === 'run'))
  assert.ok(decl.abilities.some(a => a.name === 'add'))
  await app.terminate()

  const explicit = new NApp({ id: 'd2', decl: { events: [{ name: 'only', description: 'x' }], abilities: [] } })
  explicit.bindProcessor('event', makeNaceb().nacpAdaptor)
  await explicit.start()
  assert.deepEqual(explicit.buildDecl(), { events: [{ name: 'only', description: 'x' }], abilities: [] })
  await explicit.terminate()
})

test('没有 id 直接抛', () => {
  assert.throws(() => new NApp({ id: '' }), (e) => e.code === 'no-id')
})

// ── 生命周期 ──

test('start 幂等，重复调不重复监听', async () => {
  const app = new NApp({ id: 'idem', server: [tcp(PORT.napp)] })
  await app.start()
  await app.start()
  await app.start()
  assert.ok(true, '三次 start 没抛也没端口冲突')
  await app.terminate()
})

test('connect 前必须 start', async () => {
  const app = new NApp({ id: 'notyet' })
  await assert.rejects(app.connect('anyone', tcp(PORT.napp)), (e) => e.code === 'not-started')
  await app.terminate()
})

test('connect 的 expect 填错 → register-failed（要等满 10s 超时）', async () => {
  // 对端看到 to≠self 会静默丢弃 register，不回话 —— 所以 dialler 只能等自己的 10s 超时。
  // 这是刻意设计（NACP.onRegister 的注释：「你拨错了 App」就是靠超时浮现），不是 bug，
  // 代价是这条测试必然慢。它是唯一一条慢的，所以留着而不是拿 mock 绕过去。
  const peer = await spawnPeer({ id: 'realname', server: [tcp(PORT.napp)] })
  const app = await startApp('dialer')

  const t0 = performance.now()
  await assert.rejects(app.app.connect('错名字', tcp(PORT.napp)), (e) => e.code === 'register-failed')
  const ms = performance.now() - t0
  assert.ok(ms > 9000, `应该是等满超时才失败，实测 ${ms.toFixed(0)}ms`)
  assert.deepEqual(app.app.listConnectedApp(), [], '没建立连接')

  await app.stop()
  await peer.stop()
})

test('terminate 之后所有出站 API 都拒绝', async () => {
  const app = await startApp('stopping')
  await app.app.terminate()

  await assert.rejects(app.app.request('x', { kind: 'ability', target: 't' }), (e) => e.code === 'stopping')
  await assert.rejects(app.app.unsubscribe('x', 's'), (e) => e.code === 'stopping')
  await assert.rejects(app.app.connect('x', tcp(PORT.napp)), (e) => e.code === 'stopping')
  await assert.rejects(app.app.disconnect('x'), (e) => e.code === 'stopping')
  assert.throws(() => app.app.subscribe('x', 'y'), (e) => e.code === 'stopping')
  assert.equal(await app.app.notify('x', { parentId: 'p', targetSubName: 'a', hitSubName: 'a' }), false)
  assert.equal(await app.app.response('x', { parentId: 'p', isOk: true }), false)
})

test('terminate 幂等', async () => {
  const app = await startApp('twice')
  await app.app.terminate()
  await app.app.terminate()
  assert.ok(true)
})

test('terminate 会向对端发 unregister，对端随之解绑', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('leaver')
  await app.app.connect('srv', tcp(PORT.napp))
  assert.deepEqual((await peer.ask('peers')).peers, ['leaver'])

  await app.app.terminate()
  await sleep(120)
  assert.deepEqual((await peer.ask('peers')).peers, [], '对端知道我走了')

  await peer.stop()
})

// ── connect / disconnect ──

test('disconnect 只断一个，其他链路不受影响，还能连回来', async () => {
  const a = await spawnPeer({ id: 'A', server: [tcp(PORT.napp)] })
  const b = await spawnPeer({ id: 'B', server: [tcp(PORT.nappB)] })
  const me = await startApp('me')

  await me.app.connect('A', tcp(PORT.napp))
  await me.app.connect('B', tcp(PORT.nappB))
  assert.deepEqual(me.app.listConnectedApp().sort(), ['A', 'B'])

  assert.equal(await me.app.disconnect('A'), true)
  assert.deepEqual(me.app.listConnectedApp(), ['B'], 'B 不受影响')
  await sleep(80)
  assert.deepEqual((await a.ask('peers')).peers, [], 'A 那边也清了')
  assert.deepEqual((await b.ask('peers')).peers, ['me'], 'B 那边还在')

  // B 仍然能用
  const res = await me.app.request('B', { kind: 'ability', target: 'add', payload: { a: 1, b: 1 } })
  assert.equal(res.payload, 2)

  // A 能重连
  await me.app.connect('A', tcp(PORT.napp))
  assert.deepEqual(me.app.listConnectedApp().sort(), ['A', 'B'])

  await me.stop(); await a.stop(); await b.stop()
})

test('disconnect 一个没连过的 appId 返 false', async () => {
  const app = await startApp('solo')
  assert.equal(await app.app.disconnect('从未连过'), false)
  await app.stop()
})

test('对端进程死掉 → 本地自动清理', async () => {
  const peer = await spawnPeer({ id: 'dying', server: [tcp(PORT.nappB)] })
  const app = await startApp('survivor')
  await app.app.connect('dying', tcp(PORT.nappB))
  assert.deepEqual(app.app.listConnectedApp(), ['dying'])

  peer.child.kill('SIGKILL')
  await sleep(200)

  assert.deepEqual(app.app.listConnectedApp(), [], '物理断连触发了 NACP 清表')
  await app.stop()
})

test('对端死掉时在途请求会失败，不会永远挂着', async () => {
  const peer = await spawnPeer({ id: 'dying2', server: [tcp(PORT.nappC)] })
  const app = await startApp('waiter')
  await app.app.connect('dying2', tcp(PORT.nappC))

  // hang 事件永不返回；杀掉对端应该让它 reject
  const pending = app.app.request('dying2', { kind: 'event', target: 'run', payload: { task: 'hang' } })
  await sleep(80)
  peer.child.kill('SIGKILL')

  await assert.rejects(pending, (e) => {
    assert.ok(/disconnect/i.test(e.message), `失败原因应提到断连：${e.message}`)
    return true
  })
  await app.stop()
})

// ── 请求 ──

test('ability 与 event 端到端，含过程流', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const ab = await app.app.request('srv', { kind: 'ability', target: 'add', payload: { a: 20, b: 22 } })
  assert.equal(ab.payload, 42)

  const chunks = []
  const ev = await app.app.request('srv', {
    kind: 'event', target: 'run', payload: { task: 'emit', n: 4 },
    onProcess: (c) => chunks.push(c.i),
  })
  assert.deepEqual(chunks, [0, 1, 2, 3], '过程流按序到齐')
  assert.deepEqual(ev.payload, { emitted: 4 })

  await app.stop(); await peer.stop()
})

test('并发请求各自对上自己的响应', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => app.app.request('srv', { kind: 'ability', target: 'add', payload: { a: i, b: 100 } })),
  )
  assert.deepEqual(results.map(r => r.payload), Array.from({ length: 20 }, (_, i) => i + 100))

  await app.stop(); await peer.stop()
})

test('多个 event 的过程流不会串台', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const boxes = [[], [], []]
  await Promise.all(boxes.map((box, i) => app.app.request('srv', {
    kind: 'event', target: 'run', payload: { task: 'emit', n: i + 2 },
    onProcess: (c) => box.push(c.i),
  })))

  assert.deepEqual(boxes[0], [0, 1])
  assert.deepEqual(boxes[1], [0, 1, 2])
  assert.deepEqual(boxes[2], [0, 1, 2, 3])
  await app.stop(); await peer.stop()
})

test('未知 target / 失败的 handler 都 reject', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  await assert.rejects(app.app.request('srv', { kind: 'ability', target: '没这个', payload: {} }),
    (e) => e.code === 'response-not-ok')
  await assert.rejects(app.app.request('srv', { kind: 'ability', target: 'fail', payload: {} }),
    (e) => e.code === 'response-not-ok')
  await assert.rejects(app.app.request('srv', { kind: 'event', target: '没这个事件', payload: {} }),
    (e) => e.code === 'response-not-ok')

  await app.stop(); await peer.stop()
})

test('发给没连过的 appId 会 reject', async () => {
  const app = await startApp('lonely')
  await assert.rejects(app.app.request('陌生人', { kind: 'ability', target: 't', payload: {} }))
  await app.stop()
})

test('NApp.introduce：拿对端的完整声明', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const res = await app.app.request('srv', { kind: 'ability', target: 'NApp.introduce', payload: {} })
  assert.ok(res.payload.events.some(e => e.name === 'run'))
  assert.ok(res.payload.abilities.some(a => a.name === 'add'))
  assert.deepEqual(res.payload, (await peer.ask('decl')).decl, '和对端自己算的一致')

  await app.stop(); await peer.stop()
})

test('大 payload 双向穿透', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const big = 'B'.repeat(300 * 1024)
  const res = await app.app.request('srv', { kind: 'ability', target: 'echo', payload: { big } })
  assert.equal(res.payload.big, big)

  await app.stop(); await peer.stop()
})

test('二进制 payload 原样往返（CBOR 字节串，不转 base64）', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const bin = new Uint8Array(1024)
  for (let i = 0; i < bin.length; i++) bin[i] = i % 256
  const res = await app.app.request('srv', { kind: 'ability', target: 'echo', payload: { bin } })
  assert.deepEqual([...res.payload.bin], [...bin])

  await app.stop(); await peer.stop()
})

// ── 订阅 ──

test('subscribe：元组两半、流、退订 id', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const [sub, stream] = app.app.subscribe('srv', 'job:*')
  const res = await sub
  assert.equal(res.meta.isOk, true)
  const subId = res.payload.targetSubId
  assert.equal(typeof subId, 'string')

  await peer.emit('job:one', { n: 1 })
  await peer.emit('job:two', { n: 2 })

  const got = []
  for await (const c of stream) { got.push(c.n); if (got.length === 2) break }
  assert.deepEqual(got, [1, 2])

  await app.stop(); await peer.stop()
})

test('回调和流共存，同一条 notify 两边都到', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const viaCb = []
  const [sub, stream] = app.app.subscribe('srv', 'both:*', (payload, msg) => {
    viaCb.push({ n: payload.n, hit: msg.meta.hitSubName })
  })
  await sub
  await peer.emit('both:hello', { n: 7 })

  const it = stream[Symbol.asyncIterator]()
  const first = await it.next()
  assert.equal(first.value.n, 7, '流收到了')
  assert.deepEqual(viaCb, [{ n: 7, hit: 'both:hello' }], '回调也收到了，且 hitSubName 是具体名')
  await it.return?.()

  await app.stop(); await peer.stop()
})

test('break 是主动退订：对端订阅表清零，回调也停', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const viaCb = []
  const [sub, stream] = app.app.subscribe('srv', 'brk:*', (p) => viaCb.push(p.n))
  await sub
  assert.equal((await peer.ask('subcount')).subs, 1, '对端记了一条')

  await peer.emit('brk:a', { n: 1 })
  for await (const c of stream) { break }           // 拿到第一条就走

  await sleep(120)
  assert.equal((await peer.ask('subcount')).subs, 0, 'break 发了真 unsubscribe')

  const before = viaCb.length
  await peer.emit('brk:b', { n: 2 })
  await sleep(100)
  assert.equal(viaCb.length, before, '退订之后回调也不再收')

  await app.stop(); await peer.stop()
})

test('unsubscribe 手动退订', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const [sub] = app.app.subscribe('srv', 'man:*', () => {})
  const subId = (await sub).payload.targetSubId
  assert.equal((await peer.ask('subcount')).subs, 1)

  const res = await app.app.unsubscribe('srv', subId)
  assert.equal(res.meta.isOk, true)
  assert.equal((await peer.ask('subcount')).subs, 0)

  await app.stop(); await peer.stop()
})

test('通配符订阅：hitSubName 区分具体事件', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const hits = []
  const [sub] = app.app.subscribe('srv', 'w:*', (_p, msg) => hits.push(msg.meta.hitSubName))
  await sub
  await peer.emit('w:alpha', {})
  await peer.emit('w:beta', {})
  await sleep(120)

  assert.deepEqual(hits.sort(), ['w:alpha', 'w:beta'], '两条能分清')
  await app.stop(); await peer.stop()
})

test('对端断开时流结束，for await 自然退出', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  const [sub, stream] = app.app.subscribe('srv', 'dead:*')
  await sub
  await peer.emit('dead:one', { n: 1 })

  const got = []
  const loop = (async () => { for await (const c of stream) got.push(c.n) })()
  await sleep(100)
  peer.child.kill('SIGKILL')

  await Promise.race([loop, sleep(2000).then(() => { throw new Error('流没结束，for await 挂住了') })])
  assert.deepEqual(got, [1], '断开前那条收到了，然后循环退出')
  await app.stop()
})

// ── 多 carrier / 组网 ──

test('一个 App 同开三种入口，三种都能连', async () => {
  const specs = [tcp(PORT.napp), ws(PORT.nappB), unix('napp-full')]
  const peer = await spawnPeer({ id: 'multi', server: specs })

  for (const spec of specs) {
    const cli = await startApp(`cli-${spec.type}`)
    await cli.app.connect('multi', spec)
    const res = await cli.app.request('multi', { kind: 'ability', target: 'add', payload: { a: 1, b: 2 } })
    assert.equal(res.payload, 3, spec.type)
    await cli.stop()
  }
  await peer.stop()
})

test('一个 App 连多个对端，互不干扰', async () => {
  const a = await spawnPeer({ id: 'A', server: [tcp(PORT.napp)] })
  const b = await spawnPeer({ id: 'B', server: [ws(PORT.nappB)] })
  const me = await startApp('hub')

  await me.app.connect('A', tcp(PORT.napp))
  await me.app.connect('B', ws(PORT.nappB))

  const [ra, rb] = await Promise.all([
    me.app.request('A', { kind: 'ability', target: 'echo', payload: { who: 'A' } }),
    me.app.request('B', { kind: 'ability', target: 'echo', payload: { who: 'B' } }),
  ])
  assert.deepEqual(ra.payload, { who: 'A' })
  assert.deepEqual(rb.payload, { who: 'B' })

  await me.stop(); await a.stop(); await b.stop()
})

test('Gateway 转发：A 经 Gateway 打到 B', async () => {
  // gw 是 Gateway；A 和 B 都连它，然后 A 直接向 B 发请求
  const gw = await spawnPeer({ id: 'gw', server: [tcp(PORT.nappGw)], opt: { isGateway: true } })
  const b = await spawnPeer({ id: 'B', server: [tcp(PORT.nappGw2)] })

  // B 主动连到 gw，让 gw 认识 B
  assert.equal((await b.ask('connect', { expect: 'gw', spec: tcp(PORT.nappGw) })).ok, true)

  const a = await startApp('A')
  await a.app.connect('gw', tcp(PORT.nappGw))

  // A 只连了 gw，没连 B —— 出站找不到 B 的路由就兜到 Gateway
  const res = await a.app.request('B', { kind: 'ability', target: 'add', payload: { a: 3, b: 4 } })
  assert.equal(res.payload, 7, '经 Gateway 转发到了 B')

  await a.stop(); await b.stop(); await gw.stop()
})

test('Gateway 声明是对端说的，本地无从指定', async () => {
  const gw = await spawnPeer({ id: 'gw', server: [tcp(PORT.nappGw)], opt: { isGateway: true } })
  const app = await startApp('client')
  await app.app.connect('gw', tcp(PORT.nappGw))

  // 从 register 应答里学到对端是 Gateway，槽位被采纳
  assert.ok(app.app.nacp.getGatewayPeerId(), '本地记住了 Gateway 槽位')
  assert.equal(app.app.isGateway, false, '自己不是 Gateway')

  await app.stop(); await gw.stop()
})

// ── 观测 ──

test('nacp / nact 事件都汇到同一个 app.bus', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('watcher')

  const nacpEv = collect(app.app.bus, 'nacp:*:*')
  const nactEv = collect(app.app.bus, 'nact:*:*')

  await app.app.connect('srv', tcp(PORT.napp))
  await app.app.request('srv', { kind: 'ability', target: 'add', payload: { a: 1, b: 1 } })

  nacpEv.stop(); nactEv.stop()
  assert.ok(nacpEv.events.length > 0, 'nacp:* 有事件')
  assert.ok(nactEv.events.some(e => e.hitKey === 'nact:peer:connect'), 'nact:peer:connect 也在同一个 bus 上')

  await app.stop(); await peer.stop()
})

test('app.bus 是完整的 EventBus，宿主可以往里折自己的信号', async () => {
  const app = await startApp('host')
  const got = []
  app.app.bus.listen('myhost:thing', (p) => got.push(p))
  app.app.bus.emit('myhost:thing', { mine: true })
  assert.deepEqual(got, [{ mine: true }])
  await app.stop()
})

test('listConnectedApp 反映当前连接', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('counter')
  assert.deepEqual(app.app.listConnectedApp(), [])
  await app.app.connect('srv', tcp(PORT.napp))
  assert.deepEqual(app.app.listConnectedApp(), ['srv'])
  await app.app.disconnect('srv')
  assert.deepEqual(app.app.listConnectedApp(), [])
  await app.stop(); await peer.stop()
})

// ── notify / response 手动口 ──

test('notify 到没订阅的对端返 true（发出去了），到陌生人返 false', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))

  assert.equal(await app.app.notify('srv', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), true,
    '交给 NACT 了就是 true —— 对端有没有人接不是发送方能知道的')
  assert.equal(await app.app.notify('陌生人', { parentId: 'x', targetSubName: 'a', hitSubName: 'a' }), false)

  await app.stop(); await peer.stop()
})

test('response 手动应答也是返布尔', async () => {
  const peer = await spawnPeer({ id: 'srv', server: [tcp(PORT.napp)] })
  const app = await startApp('cli')
  await app.app.connect('srv', tcp(PORT.napp))
  assert.equal(await app.app.response('srv', { parentId: 'no-such-req', isOk: true }), true)
  assert.equal(await app.app.response('陌生人', { parentId: 'x', isOk: true }), false)
  await app.stop(); await peer.stop()
})
