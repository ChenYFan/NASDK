import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import NApp from '../../index.ts'
import { NAppInternal } from '../../NApp/events.ts'
import { benchMeter, benchPeer, benchRequests, tcp, ws, unix, deferred, sleep } from '../_kit.mjs'
import { publishResult } from './publish.mjs'

const enabled = process.env.NASDK_PRESSURE === '1'
const warmup = Number(process.env.NASDK_BENCH_WARMUP ?? 1)
const duration = Number(process.env.NASDK_BENCH_DURATION ?? 3)
const repeats = Number(process.env.NASDK_BENCH_REPEATS ?? 3)
const output = process.env.NASDK_BENCH_OUTPUT
const profile = process.env.NASDK_BENCH_PROFILE ?? 'matrix'
const providerFilter = process.env.NASDK_BENCH_PROVIDER
const noDelay = process.env.NASDK_BENCH_NODELAY === '1'
for (const value of [warmup, duration, repeats]) assert.ok(Number.isFinite(value) && value > 0)
const environment = enabled ? { node: process.version, cpu: cpus()[0].model, memoryBytes: totalmem(),
  git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), topology: 'two processes, local loopback' } : {}

const specOf = (provider, chunkSize) => {
  const spec = provider === 'tcp' ? tcp(18990) : provider === 'websocket' ? ws(18990) : unix(`pressure-${crypto.randomUUID().slice(0, 8)}`)
  if (chunkSize) spec.nact = { chunkSize }
  return spec
}
async function clients(t, spec, count, meter, opt = {}) {
  const apps = []
  t.after(async () => { for (const app of apps) await app.terminate().catch(() => {}) })
  for (let i = 0; i < count; i++) {
    const app = meter.instrument(new NApp({ id: `bench-client-${i}`, opt: {
      heartbeatIntervalMs: false, ackTimeoutMs: 10000, reconnectGraceMs: 100, ...opt,
    } }))
    apps.push(app)
    await app.start()
    await app.connect('bench-server', spec)
  }
  return apps
}
async function report(result) {
  console.log(`BENCH ${JSON.stringify(result)}`)
  if (output) await appendFile(output, `${JSON.stringify(result)}\n`)
  await publishResult(result)
}

const cases = []
for (const provider of ['tcp', 'websocket', 'unix'].filter(p => !providerFilter || p === providerFilter)) {
  const add = cfg => cases.push({ provider, ...(noDelay && { noDelay }), ...cfg })
  if (profile === 'matrix') {
    for (const mode of ['sink', 'echo']) for (const size of [256, 4096, 65536, 1048576]) {
      add({ mode, size, connections: 1, inflight: 4 })
    }
    for (const [connections, inflight] of [[1, 1], [10, 4], [100, 1], [10, 16]]) {
      add({ mode: 'echo', size: 4096, connections, inflight })
    }
    for (const chunkSize of [65536, 1048576]) {
      add({ mode: 'echo', size: 1048576, connections: 1, inflight: 4, chunkSize })
    }
  } else if (profile === 'steady') {
    add({ mode: 'echo', size: 65536, connections: 10, inflight: 4 })
  } else if (profile === 'arrival') {
    for (const rate of [1000, 5000, 10000, 20000]) add({ mode: 'echo', size: 4096, connections: 10, inflight: 16, rate })
  } else if (profile === 'latency') {
    for (const [connections, inflight] of [[1, 1], [1, 4], [10, 4]]) {
      add({ mode: 'echo', size: 4096, connections, inflight })
    }
  } else if (profile !== 'boundary') throw new Error(`unknown profile: ${profile}`)
}

test('原生 SDK 压力矩阵：完整响应、载荷校验和独立进程指标', { skip: !enabled }, async t => {
  for (const cfg of cases) for (let repeat = 1; repeat <= repeats; repeat++) {
    await t.test(`${JSON.stringify(cfg)} repeat=${repeat}`, { timeout: (warmup + duration + 45) * 1000 }, async t => {
      const spec = specOf(cfg.provider, cfg.chunkSize), meter = benchMeter({ noDelay })
      meter.labels = { role: 'client', provider: cfg.provider, mode: cfg.mode, size: cfg.size }
      const peer = await benchPeer(t, spec, noDelay), apps = await clients(t, spec, cfg.connections, meter)
      const prepared = await benchRequests(apps, cfg, warmup)
      assert.equal(prepared.aborted, false, 'warmup stalled')
      assert.equal(prepared.failed, 0, JSON.stringify(prepared.errors))
      await sleep(50)
      await peer.ask('start'); meter.start()
      const result = await benchRequests(apps, cfg, duration)
      const client = meter.stop(), server = (await peer.ask('stop')).metrics
      await report({ kind: 'request', environment, cfg, repeat, warmup, duration, ...result, client, server })
      assert.equal(result.aborted, false, 'phase drain deadline exceeded')
      assert.equal(result.failed, 0, JSON.stringify(result.errors))
      assert.ok(result.completed > 0)
    })
  }
})

test('原生 SDK 边界：大包、Notify 洪流及慢消费者', { skip: !enabled }, async t => {
  for (const provider of ['tcp', 'websocket', 'unix'].filter(p => !providerFilter || p === providerFilter)) {
    await t.test(`${provider}: 16 MiB 分片回显`, { timeout: 45000 }, async t => {
      const spec = specOf(provider, 65536), meter = benchMeter(), peer = await benchPeer(t, spec)
      const apps = await clients(t, spec, 1, meter)
      await peer.ask('start'); meter.start()
      const cfg = { provider, mode: 'echo', size: 16 * 1024 ** 2, connections: 1, inflight: 1, chunkSize: 65536 }
      const result = await benchRequests(apps, cfg, 1)
      await report({ kind: 'large-payload', cfg, ...result, client: meter.stop(), server: (await peer.ask('stop')).metrics })
      assert.equal(result.failed, 0); assert.equal(result.aborted, false); assert.ok(result.completed > 0)
    })
    for (const slow of [false, true]) await t.test(`${provider}: notify slow=${slow}`, { timeout: 30000 }, async t => {
      const count = slow ? 2048 : 10000, max = slow ? 16 : 16384, size = 256
      const meter = benchMeter(), spec = specOf(provider), peer = await benchPeer(t, spec)
      const [app] = await clients(t, spec, 1, meter, { queueMaxCount: max })
      let received = 0, dropped = 0
      const all = deferred()
      app.bus.listen(NAppInternal.notifyWarning, () => dropped++)
      const { response, stream } = app.subscribe('bench-server', 'bench:notify', () => {
        if (++received === count) all.resolve()
      })
      await response
      const got = [], begin = performance.now()
      const consume = async n => {
        for await (const message of stream) {
          got.push(message.payload.i)
          assert.equal(message.payload.data.byteLength, size)
          if (got.length === n) break
        }
      }
      const consuming = slow ? undefined : consume(count)
      await peer.ask('start'); meter.start()
      await peer.ask('notify', { count, size })
      await all.promise
      if (slow) await consume(max)
      else await consuming
      const elapsedMs = performance.now() - begin
      await report({ kind: 'notify', provider, slow, count, received, consumed: got.length, dropped, elapsedMs,
        msgPerSec: got.length / (elapsedMs / 1000), client: meter.stop(), server: (await peer.ask('stop')).metrics })
      assert.equal(dropped, slow ? count - max : 0)
      assert.deepEqual(got, Array.from({ length: slow ? max : count }, (_, i) => i + (slow ? count - max : 0)))
    })
  }
})
