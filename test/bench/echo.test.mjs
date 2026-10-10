import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { benchMeter, benchPeer, benchRequests, benchLoadConfig, benchSteps, benchNacpPair, sleep } from '../_kit.mjs'
import NApp from '../../index.ts'
import { cborCodec } from '../../NACT/codec.ts'
import { buildMessage } from '../../NACP/types.ts'
import { publishResult } from './publish.mjs'
import { execFileSync } from 'node:child_process'
import { createTransport } from './providers.mjs'

const dir = new URL('./results/', import.meta.url)
await mkdir(dir, { recursive: true })
const scanSeconds = Number(process.env.NASDK_CAPACITY_SCAN_SECONDS ?? 5)
const holdSeconds = Number(process.env.NASDK_CAPACITY_HOLD_SECONDS ?? 0)
if (holdSeconds > 30 && !process.env.NASDK_BENCH_CPUS) throw new Error('Large holds require explicit NASDK_BENCH_CPUS; use npm run test:bench')
const selected = process.env.NASDK_CAPACITY_PROVIDER
const providers = ['nacp-direct', 'unix', 'tcp', 'streamable-http', 'websocket'].filter(p => !selected || selected === p)
if (!providers.length) throw new Error(`Unknown provider: ${selected}`)
const stages = (process.env.NASDK_CAPACITY_STAGES ?? 'scan,hold,arrival,recovery').split(',')
for (const stage of stages) if (!['scan', 'hold', 'arrival', 'recovery'].includes(stage)) throw new Error(`Unknown native stage: ${stage}`)
const positive = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}
const sizes = process.env.NASDK_CAPACITY_SIZE ? [positive('NASDK_CAPACITY_SIZE')] : [256, 65536, 1048576]
const connectionCount = positive('NASDK_CAPACITY_CONNECTIONS', 4)
const explicitInflight = process.env.NASDK_CAPACITY_INFLIGHT && positive('NASDK_CAPACITY_INFLIGHT')
const explicitVus = process.env.NASDK_CAPACITY_VUS && positive('NASDK_CAPACITY_VUS')
const vuInflight = process.env.NASDK_CAPACITY_VU_INFLIGHT && positive('NASDK_CAPACITY_VU_INFLIGHT')
const vuSteps = benchSteps(process.env.NASDK_CAPACITY_VU_STEPS)
if (explicitInflight && (explicitVus || vuInflight || vuSteps)) throw new Error('Use --vu-inflight with VU parameters; --inflight is the legacy per-connection option')
const chosenSize = positive('NASDK_CAPACITY_SIZE', 65536)
const mode = process.env.NASDK_CAPACITY_MODE ?? 'echo'
if (!['echo', 'sink'].includes(mode)) throw new Error('Mode must be echo or sink')
const noDelay = process.env.NASDK_BENCH_NODELAY === '1'
const environment = { git: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version,
  affinity: execFileSync('taskset', ['-pc', String(process.pid)], { encoding: 'utf8' }).trim(),
  noDelay, profile: holdSeconds > 30 ? 'user-large' : 'short-exploration',
   rssLimitBytes: positive('NASDK_CAPACITY_RSS_LIMIT_MIB', 2048) * 1024 ** 2,
   inFlightPayloadLimitBytes: positive('NASDK_CAPACITY_PAYLOAD_LIMIT_MIB', 64) * 1024 ** 2 }
const limits = { rss: environment.rssLimitBytes }
const queueMaxCount = positive('NASDK_CAPACITY_QUEUE_MAX_COUNT', 1024)
environment.queueMaxCount = queueMaxCount
const file = new URL(`capacity-${selected ?? 'all'}-${Date.now()}${noDelay ? '-nodelay' : ''}.jsonl`, dir)
await writeFile(file, '')
const protocol = sizes.map(size => {
  const request = buildMessage('bench-client-0', 'request', 'bench-server', { kind: 'ability', target: 'bench.echo',
    payload: { seq: 123456, data: new Uint8Array(size) } })
  const response = buildMessage('bench-server', 'response', 'bench-client-0', { kind: 'ability', parentId: request.id, isOk: true,
    payload: { seq: 123456, length: size, data: new Uint8Array(size) } })
  const bytes = msg => cborCodec.encode(msg).byteLength + 32
  const ackRequest = buildMessage('bench-server', 'ack', 'bench-client-0', { parentId: request.id })
  const ackResponse = buildMessage('bench-client-0', 'ack', 'bench-server', { parentId: response.id })
  return { size, requestBytes: bytes(request), responseBytes: bytes(response), ackRequestBytes: bytes(ackRequest),
    ackResponseBytes: bytes(ackResponse), wireBytesPerCall: bytes(request) + bytes(response) + bytes(ackRequest) + bytes(ackResponse) }
})
await writeFile(new URL('protocol-budget.json', dir), JSON.stringify(protocol, null, 2))

async function report(result) {
  result.environment = environment
  await appendFile(file, `${JSON.stringify(result)}\n`)
  console.log(`CAPACITY ${result.cfg.provider} ${result.cfg.stage} ${result.cfg.size}B ${result.vus} VU / ${result.connections} connections / ${result.vuInflight} inflight/VU (total ${result.totalInflight}): ${result.msgPerSec.toFixed(0)}/s, P99 ${result.latencyMs.p99.toFixed(2)}ms, RSS ${(result.client.rssPeakBytes / 1048576).toFixed(0)}/${result.server ? (result.server.rssPeakBytes / 1048576).toFixed(0) : 'combined'} MiB, failed=${result.failed}`)
  await publishResult(result)
}
test('NACP 与四种传输：连续容量扫描、稳态及内存恢复', { timeout: 14400000 }, async t => {
  for (const provider of providers) await t.test(provider, async t => {
    const clientMeter = benchMeter({ noDelay })
    let apps, peer, probe
    if (provider === 'nacp-direct') apps = await benchNacpPair(t)
    else {
      const spec = await createTransport(provider, { port: Number(process.env.NASDK_PRESSURE_PORT ?? 18996),
        bufferMiB: positive('NASDK_CAPACITY_HTTP_BUFFER_MIB', 64) })
      peer = await benchPeer(t, spec, noDelay)
      apps = []
      t.after(async () => { for (const app of apps) await app.terminate().catch(() => {}) })
      for (let i = 0; i < connectionCount; i++) {
        const app = clientMeter.instrument(new NApp({ id: `bench-client-${i}`, opt: { heartbeatIntervalMs: false, ackTimeoutMs: 10000, queueMaxCount } }))
        apps.push(app); await app.start(); await app.connect('bench-server', spec)
      }
      probe = clientMeter.instrument(new NApp({ id: 'bench-probe', opt: { heartbeatIntervalMs: false, ackTimeoutMs: 10000 } }))
      t.after(() => probe.terminate().catch(() => {}))
      await probe.start(); await probe.connect('bench-server', spec)
    }
    const results = []
    const phase = async (size, inflight, stage, seconds, rate, vus = explicitVus, perVu = vuInflight) => {
      const load = benchLoadConfig(apps.length, { inflight, ...(vus && { vus }), ...(perVu && { vuInflight: perVu }) })
      if (size * load.totalInflight > environment.inFlightPayloadLimitBytes) throw new Error(`In-flight payload exceeds ${environment.inFlightPayloadLimitBytes / 1048576} MiB experimental limit`)
      const cfg = { provider, mode, size, stage, ...load, ...(rate && { rate }), noDelay }
      console.log(`START ${provider} ${stage}: ${size}B, ${load.vus} VU, ${load.connections} connections (${load.usedConnections} used), ${load.vuInflight} inflight/VU, ${seconds}s`)
      clientMeter.labels = { role: provider === 'nacp-direct' ? 'combined' : 'client', provider, size, stage,
        ...load, ...(process.env.NASDK_BENCH_RUN && { run: process.env.NASDK_BENCH_RUN }) }
      await peer?.ask('start'); clientMeter.start()
      let probePassed = 0, probeFailed = 0, active = false, probeWork = Promise.resolve()
      const timer = setInterval(() => {
        if (active) return
        active = true
        probeWork = (async () => {
          try {
            const response = await (probe ?? apps[0]).request('bench-server', { kind: 'ability', target: 'bench.sink',
              payload: { seq: -1, data: new Uint8Array([1, 2, 3]) } }).response
            assert.equal(response.payload.seq, -1); assert.equal(response.payload.length, 3)
            probePassed++
          } catch { probeFailed++ }
          finally { active = false }
        })()
      }, 1000)
      let result
      try { result = await benchRequests(apps, cfg, seconds) }
      finally { clearInterval(timer) }
      // A probe stalled by pressure is itself a failure; teardown settles its pending call.
      if (active) await Promise.race([probeWork, sleep(2000).then(() => { if (active) probeFailed++ })])
      const client = clientMeter.stop(), server = (await peer?.ask('stop'))?.metrics
      await report({ cfg, connections: apps.length, seconds, ...result, probePassed, probeFailed, client, server })
      assert.equal(result.aborted, false, `phase drain exceeded 15s; errors=${JSON.stringify(result.errors)}, server warnings=${JSON.stringify(server?.warnings ?? {})}`)
      assert.equal(result.failed, 0, JSON.stringify(result.errors))
      assert.equal(probeFailed, 0, 'same-target probe failed or stalled')
      assert.ok(client.rssPeakBytes < limits.rss && (!server || server.rssPeakBytes < limits.rss), `RSS exceeds ${limits.rss / 1048576} MiB per process`)
      results.push({ cfg, ...result })
      return result
    }
    await phase(256, 1, 'warmup', Number(process.env.NASDK_CAPACITY_WARMUP_SECONDS ?? 2), undefined, apps.length, 1)
    if (stages.includes('scan')) for (const size of sizes) for (const vus of vuSteps ?? [explicitVus]) {
      for (const inflight of vus || vuInflight ? [1] : explicitInflight ? [explicitInflight] : [1, 4, 16, 64]) {
        const load = benchLoadConfig(apps.length, { inflight, ...(vus && { vus }), ...(vuInflight && { vuInflight }) })
        if (size * load.totalInflight > environment.inFlightPayloadLimitBytes) {
          console.log(`SKIP ${provider} scan ${size}B ${load.vus} VU: total in-flight payload exceeds ${environment.inFlightPayloadLimitBytes / 1048576} MiB`)
          continue
        }
        await phase(size, inflight, 'scan', scanSeconds, undefined, vus)
      }
    }
    const winner = results.filter(r => r.cfg.size === chosenSize && r.cfg.stage === 'scan').sort((a, b) => b.msgPerSec - a.msgPerSec)[0]
    const inflight = explicitInflight ?? 4
    const holdVus = explicitVus ?? winner?.cfg.vus
    const holdVuInflight = vuInflight ?? winner?.cfg.vuInflight
    if (stages.includes('hold') && holdSeconds > 0) await phase(chosenSize, inflight, 'saturated-hold', holdSeconds, undefined, holdVus, holdVuInflight)
    const arrivalSeconds = Number(process.env.NASDK_CAPACITY_ARRIVAL_SECONDS ?? 3)
    if (stages.includes('arrival') && arrivalSeconds > 0) {
      if (!winner && !process.env.NASDK_CAPACITY_RATE) throw new Error('Standalone arrival stage requires --rate (or NASDK_CAPACITY_RATE)')
      if (process.env.NASDK_CAPACITY_RATE) await phase(chosenSize, inflight, 'arrival-explicit', arrivalSeconds, positive('NASDK_CAPACITY_RATE'), holdVus, holdVuInflight)
      else {
      // Arrival rate needs scheduling headroom independent of the closed-loop winner's cap.
      await phase(chosenSize, 16, 'arrival-70', arrivalSeconds, Math.floor(winner.msgPerSec * 0.7), holdVus, Math.max(16, holdVuInflight ?? inflight))
      await phase(chosenSize, 16, 'arrival-120', arrivalSeconds, Math.floor(winner.msgPerSec * 1.2), holdVus, Math.max(16, holdVuInflight ?? inflight))
      }
    }
    if (!stages.includes('recovery')) return
    clientMeter.labels = { role: provider === 'nacp-direct' ? 'combined' : 'client', provider, stage: 'recovery', size: 65536 }
    await peer?.ask('start'); clientMeter.start(); await sleep(Number(process.env.NASDK_CAPACITY_RECOVERY_SECONDS ?? 5))
    const recovered = { client: clientMeter.stop(), server: (await peer?.ask('stop'))?.metrics }
    await appendFile(file, `${JSON.stringify({ kind: 'recovery', provider, ...recovered })}\n`)
    await publishResult({ kind: 'recovery', provider, ...recovered })
  })
})
