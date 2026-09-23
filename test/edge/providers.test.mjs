import { test } from 'node:test'
import assert from 'node:assert/strict'
import NApp from '../../index.ts'
import { CustomTransportProvider } from '../../NACT/index.ts'
import HTTPHandler from '../../packages/nact-streamable-http-server/handler.ts'
import HTTPClient from '../../packages/nact-streamable-http-client/index.ts'
import { ByteChannel } from '../../packages/nact-channel/index.ts'
import { sleep } from '../_kit.mjs'
import { httpPair } from '../_http.mjs'

const request = (method = 'GET', token, body) => new Request('http://localhost/nacp', {
  method, headers: { 'content-type': 'application/octet-stream', ...(token ? { 'x-nact-session': token } : {}) }, body,
})

test('HTTP validates methods, authorization, unknown sessions and capacity', async () => {
  const provider = new HTTPHandler()
  assert.equal((await provider.handle(request())).status, 503)
  const handle = await provider.listen({ maxSessions: 1,
    authorize: req => req.headers.get('authorization') === 'Bearer test' }, () => {})
  const send = async req => { req.headers.set('authorization', 'Bearer test'); return provider.handle(req) }
  try {
    assert.equal((await provider.handle(request())).status, 403)
    assert.equal((await send(request('PUT'))).status, 405)
    assert.equal((await send(request('POST', 'unknown', new Uint8Array([1])))).status, 404)
    const stream = await send(request())
    assert.equal(stream.status, 200)
    assert.equal((await send(request())).status, 503)
    const token = stream.headers.get('x-nact-session')
    const badType = request('POST', token); badType.headers.set('content-type', 'application/json')
    assert.equal((await send(badType)).status, 415)
    assert.equal((await send(request('DELETE', token))).status, 204)
    assert.equal(provider.sessionCount, 0)
    await stream.body.cancel()
  } finally { await handle.close() }
})

test('HTTP overflow, cancellation and idle expiry release sessions', async () => {
  for (const action of ['receive-overflow', 'send-overflow', 'cancel', 'idle']) {
    const provider = new HTTPHandler()
    let channel
    const handle = await provider.listen({ maxBodyBytes: 8, maxBufferedBytes: 8, idleTimeoutMs: 30 }, c => { channel = c })
    const stream = await provider.handle(request())
    try {
      if (action === 'receive-overflow')
        assert.equal((await provider.handle(request('POST', stream.headers.get('x-nact-session'), new Uint8Array(9)))).status, 413)
      if (action === 'send-overflow') assert.throws(() => channel.send([new Uint8Array(9)]), { code: 'send-buffer-overflow' })
      if (action === 'cancel') await stream.body.cancel()
      if (action === 'idle') await sleep(60)
      assert.equal(provider.sessionCount, 0, action)
    } finally { await stream.body.cancel().catch(() => {}); await handle.close() }
  }
})

test('HTTP rejects concurrent POSTs; fragmented body is delivered in order', async () => {
  const provider = new HTTPHandler()
  const received = []
  const handle = await provider.listen({}, c => c.onReceive(bytes => received.push(...bytes)))
  const stream = await provider.handle(request())
  const token = stream.headers.get('x-nact-session')
  let controller
  const body = new ReadableStream({ start(c) { controller = c } })
  const first = provider.handle(new Request('http://localhost/nacp', {
    method: 'POST', headers: { 'x-nact-session': token, 'content-type': 'application/octet-stream' }, body, duplex: 'half',
  }))
  try {
    assert.equal((await provider.handle(request('POST', token, new Uint8Array([9])))).status, 409)
    controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3])); controller.close()
    assert.equal((await first).status, 204)
    assert.deepEqual(received, [1, 2, 3])
  } finally { await stream.body.cancel(); await handle.close() }
})

test('HTTP client keepalive and abort clean both peers', async () => {
  const controller = new AbortController()
  const { cli, provider, stop } = await httpPair('http', { idleTimeoutMs: 100 }, { keepAliveMs: 20, signal: controller.signal })
  try {
    await sleep(250)
    assert.equal(provider.sessionCount, 1)
    controller.abort()
    await sleep(80)
    assert.equal(provider.sessionCount, 0)
    assert.deepEqual(cli.nact.listPeerId(), [])
  } finally { await stop() }
})

test('HTTP client rejects invalid connect responses and times out an unanswered dial', async () => {
  const client = new HTTPClient()
  await assert.rejects(client.dial({ url: 'http://localhost', fetch: async () => new Response('no session') }), { code: 'http-connect-200' })
  await assert.rejects(client.dial({ url: 'http://localhost', requestTimeoutMs: 10,
    fetch: (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) }),
  { code: 'connect-timeout' })
})

test('Channel iterator locks receive mode and failure wakes pending readers', async () => {
  let closes = 0
  const channel = new ByteChannel({ send() {}, close() { closes++ } })
  const iterator = channel[Symbol.asyncIterator]()
  assert.throws(() => channel.onReceive(() => {}), { code: 'receive-mode-conflict' })
  const pending = iterator.next()
  channel.fail(new Error('failed'))
  await assert.rejects(pending, /failed/)
  await channel.close()
  assert.equal(closes, 1)
})

test('NACT async send failure stops queued frames and cleans peer once', async () => {
  const app = new NApp({ id: 'send-failure' })
  const provider = new CustomTransportProvider({ type: 'custom', provider: {}, nact: { chunkSize: 64 } })
  app.nact.use(provider)
  let sends = 0, terminates = 0, closes = 0, errors = 0, disconnects = 0
  app.bus.listen('nact:peer:error', () => errors++)
  app.bus.listen('nact:peer:disconnect', () => disconnects++)
  const endpoint = provider.open({ send: async () => { sends++; throw new Error('write failed') },
    close: () => closes++, terminate: () => terminates++ })
  app.nact.sendToPeer(endpoint.peerId, { payload: 'x'.repeat(500) })
  await sleep(20)
  assert.equal(sends, 1)
  assert.equal(terminates, 1)
  assert.equal(closes, 0)
  assert.equal(errors, 1)
  assert.equal(disconnects, 1)
  assert.deepEqual(app.nact.listPeerId(), [])
  await app.terminate()
})

test('NACT rejected close resolves closePeer and emits one error', async () => {
  const app = new NApp({ id: 'close-failure' })
  const provider = new CustomTransportProvider({ type: 'custom', provider: {} })
  app.nact.use(provider)
  const endpoint = provider.open({ send() {}, close: async () => { throw new Error('close failed') } })
  assert.equal(await app.nact.closePeer(endpoint.peerId), true)
  await app.terminate()
  assert.throws(() => provider.open({ send() {}, close() {} }), { code: 'transport-stopped' })
})

test('NACT graceful close drains asynchronous frames before closing the sink', async () => {
  const app = new NApp({ id: 'drain' })
  const provider = new CustomTransportProvider({ type: 'memory', provider: {}, nact: { chunkSize: 64 } })
  app.nact.use(provider)
  const order = []
  let release
  const endpoint = provider.open({
    send: async () => {
      order.push('send')
      if (order.length === 1) await new Promise(resolve => { release = resolve })
    },
    close: () => { order.push('close'); endpoint.closed() },
  })
  app.nact.sendToPeer(endpoint.peerId, { payload: 'x'.repeat(200) })
  const closing = app.nact.closePeer(endpoint.peerId)
  assert.deepEqual(order, ['send'])
  release()
  assert.equal(await closing, true)
  assert.equal(order.at(-1), 'close')
  assert.ok(order.length > 3, 'all fragmented frames drained')
  await app.terminate()
})

test('NACT validates providers and chunk size before starting physical I/O', async () => {
  const app = new NApp({ id: 'validation' })
  assert.throws(() => app.nact.use({ type: 'x', role: 'wrong', defaultChunkSize: 64 }), { code: 'invalid-provider' })
  assert.throws(() => app.nact.use({ type: 'x', role: 'client', defaultChunkSize: 64 }), { code: 'invalid-provider' })
  let calls = 0
  app.nact.use({ type: 'x', role: 'client', defaultChunkSize: 64, dial: () => { calls++ } })
  for (const chunkSize of [0, -1, NaN, Infinity, 1.5, 2 ** 31 + 1])
    await assert.rejects(app.nact.dial({ type: 'x', provider: {}, nact: { chunkSize } }), { code: 'invalid-chunk-size' })
  assert.equal(calls, 0)
  await app.terminate()
})

test('NACT shuts down all server handles even if one rejects, without losing this', async () => {
  const app = new NApp({ id: 'shutdown' })
  const closed = []
  for (const type of ['a', 'b']) app.nact.use({ type, role: 'server', defaultChunkSize: 64,
    listen: async () => ({ type, close() {
      closed.push(this.type)
      return this.type === 'a' ? Promise.reject(new Error('close a')) : Promise.resolve()
    } }),
  })
  await app.nact.listen({ type: 'a', provider: {} })
  await app.nact.listen({ type: 'b', provider: {} })
  await assert.rejects(app.nact.terminate(), AggregateError)
  await assert.rejects(app.nact.terminate(), AggregateError)
  assert.deepEqual(closed.sort(), ['a', 'b'])
})

test('NACT dial completing during termination closes the late channel', async () => {
  const app = new NApp({ id: 'late-dial' })
  let resolve, closes = 0
  app.nact.use({ type: 'late', role: 'client', defaultChunkSize: 64,
    dial: () => new Promise(done => { resolve = done }),
  })
  const dial = app.nact.dial({ type: 'late', provider: {} })
  await app.nact.terminate()
  resolve(new ByteChannel({ send() {}, close() { closes++ } }))
  await assert.rejects(dial, { code: 'transport-stopped' })
  assert.equal(closes, 1)
  assert.deepEqual(app.nact.listPeerId(), [])
})

test('NACT listen completing during shutdown discards late accepts and closes its handle', async () => {
  const app = new NApp({ id: 'late-listen' })
  let accept, ready, closed = 0, handles = 0
  app.nact.use({ type: 'late', role: 'server', defaultChunkSize: 64,
    listen: (_options, onAccept) => { accept = onAccept; return new Promise(resolve => { ready = resolve }) },
  })
  const listening = app.nact.listen({ type: 'late', provider: {} })
  await app.nact.terminate()
  assert.doesNotThrow(() => accept(new ByteChannel({ send() {}, close() { closed++ } })))
  ready({ close: async () => { handles++ } })
  await assert.rejects(listening, { code: 'transport-stopped' })
  assert.equal(closed, 1)
  assert.equal(handles, 1)
  assert.deepEqual(app.nact.listPeerId(), [])
})

test('HTTP closing a session cancels an unfinished upload', async () => {
  const provider = new HTTPHandler()
  const handle = await provider.listen({}, () => {})
  const stream = await provider.handle(request())
  const token = stream.headers.get('x-nact-session')
  let cancelled = false
  const upload = provider.handle(new Request('http://localhost/nacp', {
    method: 'POST', headers: { 'x-nact-session': token, 'content-type': 'application/octet-stream' },
    body: new ReadableStream({ cancel() { cancelled = true } }), duplex: 'half',
  }))
  try {
    await provider.handle(request('DELETE', token))
    assert.equal((await upload).status, 404)
    assert.equal(cancelled, true)
    assert.equal(provider.sessionCount, 0)
  } finally { await stream.body.cancel(); await handle.close() }
})

test('HTTP sessions stay isolated when one client cancels', async () => {
  const provider = new HTTPHandler()
  const handle = await provider.listen({}, channel => channel.onReceive(bytes => channel.send([bytes])))
  const streams = await Promise.all([provider.handle(request()), provider.handle(request())])
  try {
    await streams[0].body.cancel()
    const reader = streams[1].body.getReader()
    assert.deepEqual((await reader.read()).value, new Uint8Array([78, 65, 67, 84, 1]))
    await provider.handle(request('POST', streams[1].headers.get('x-nact-session'), new Uint8Array([11, 22])))
    assert.deepEqual((await reader.read()).value, new Uint8Array([11, 22]))
    assert.equal(provider.sessionCount, 1)
    await reader.cancel()
  } finally { await handle.close() }
})
