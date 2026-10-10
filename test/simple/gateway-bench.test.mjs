import { test } from 'node:test'
import assert from 'node:assert/strict'
import { benchPeer, benchGatewayUsers, benchMeter } from '../_kit.mjs'
import { createTransport } from '../bench/providers.mjs'

for (const transport of ['unix', 'tcp', 'websocket', 'streamable-http']) test(`Gateway ${transport}：独立身份经单上游链路MUX`, async t => {
  const spec = await createTransport(transport, { host: '127.0.0.1', port: 18998, users: 3,
    name: `gateway-simple-${crypto.randomUUID().slice(0, 8)}` })
  const gateway = await benchPeer(t, spec, false, { gateway: true })
  const upstream = await benchPeer(t, spec, false, { upstream: true })
  const apps = await benchGatewayUsers(t, spec, 3, 1, benchMeter())
  assert.equal((await gateway.ask('peers')).peers, 4)
  assert.equal((await upstream.ask('peers')).peers, 1)
  assert.equal(new Set(apps.map(app => app.id)).size, 3)
  await Promise.all(apps.map(async (app, seq) => {
    const data = new Uint8Array([seq, 42, 99])
    const response = await app.request('bench-server', { kind: 'ability', target: 'bench.echo', payload: { seq, data } }).response
    assert.equal(response.to, app.id)
    assert.equal(response.from, 'bench-server')
    assert.equal(response.payload.seq, seq)
    assert.deepEqual(response.payload.data, data)
  }))
  assert.equal((await upstream.ask('peers')).peers, 1)
})
