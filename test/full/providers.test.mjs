import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpPair } from '../_http.mjs'
import { sleep } from '../_kit.mjs'

for (const kind of ['http', 'next', 'nuxt']) {
  test(`${kind}: binary RPC, event stream, subscription and disconnect`, async () => {
    const { srv, cli, provider, stop } = await httpPair(kind)
    try {
      assert.equal(provider.sessionCount, 1)
      const bytes = Uint8Array.from({ length: 130_000 }, (_, n) => n % 256)
      const calls = await Promise.all(Array.from({ length: 12 }, (_, n) =>
        cli.request('srv', { kind: 'ability', target: 'echo', payload: { n, bytes } }).response))
      for (let n = 0; n < calls.length; n++) assert.deepEqual(calls[n].payload, { n, bytes })
      const event = cli.request('srv', { kind: 'event', target: 'run', payload: { n: 5 } })
      const chunks = []
      const consume = (async () => { for await (const message of event.stream) chunks.push(message.payload) })()
      await event.response; await consume
      assert.deepEqual(chunks, Array.from({ length: 5 }, (_, i) => ({ i })))
      const sub = cli.subscribe('srv', 'updates:*')
      await sub.response
      const next = sub.stream[Symbol.asyncIterator]().next()
      srv.bus.emit('updates:one', { value: 42 })
      assert.deepEqual((await next).value.payload, { value: 42 })
      await cli.unsubscribe('srv', sub.subId)
      assert.equal(await cli.disconnect('srv'), true)
      await sleep(30)
      assert.equal(provider.sessionCount, 0)
      assert.equal(srv.nact.listPeerId().length, 0)
    } finally { await stop() }
  })
}

test('HTTP client splits NACT frames across finite POST bodies', async () => {
  const { cli, stop } = await httpPair('http', { maxBodyBytes: 256 }, { maxPostBytes: 128 })
  try {
    const value = new Uint8Array(4096).fill(235)
    const response = await cli.request('srv', { kind: 'ability', target: 'echo', payload: value }).response
    assert.deepEqual(response.payload, value)
  } finally { await stop() }
})
