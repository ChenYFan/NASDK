import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { benchMeter, benchPeer, benchGatewayUsers, benchRequests } from '../_kit.mjs'
import { publishResult } from './publish.mjs'
import { createTransport } from './providers.mjs'

const positive = (name, fallback) => {
  const n = Number(process.env[name] || fallback)
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`)
  return n
}
const users = positive('NASDK_CAPACITY_VUS', 1024), vuInflight = positive('NASDK_CAPACITY_VU_INFLIGHT', 1)
const size = positive('NASDK_CAPACITY_SIZE', 65536), duration = positive('NASDK_CAPACITY_HOLD_SECONDS', 60)
const warmup = positive('NASDK_CAPACITY_WARMUP_SECONDS', 15)
const payloadLimit = positive('NASDK_CAPACITY_PAYLOAD_LIMIT_MIB', 64) * 1048576
const rssLimit = positive('NASDK_CAPACITY_RSS_LIMIT_MIB', 2048) * 1048576
const provider = process.env.NASDK_CAPACITY_PROVIDER ?? 'unix'
if (!['unix', 'tcp', 'websocket', 'streamable-http'].includes(provider)) throw new Error('Unsupported Gateway transport')
if (!process.env.NASDK_BENCH_CPUS) throw new Error('Use test:bench with explicit CPUs')
if (users * vuInflight * size > payloadLimit) throw new Error('Gateway in-flight payload exceeds limit')
const spec = await createTransport(provider, { port: Number(process.env.NASDK_PRESSURE_PORT ?? 18997),
  users, bufferMiB: positive('NASDK_CAPACITY_HTTP_BUFFER_MIB', 64) })
const noDelay = process.env.NASDK_BENCH_NODELAY === '1'
const dir = new URL('./results/', import.meta.url)
await mkdir(dir, { recursive: true })

test('独立 User 经 Gateway 单链路 MUX 到上游', { timeout: (users * 2 + warmup + duration + 120) * 1000 }, async t => {
  const gateway = await benchPeer(t, spec, noDelay, { gateway: true })
  const upstream = await benchPeer(t, spec, noDelay, { upstream: true })
  const meter = benchMeter({ noDelay })
  const apps = await benchGatewayUsers(t, spec, users, 1, meter)
  const cfg = { topology: 'gateway-mux', provider, mode: 'echo', users, vus: users, vuInflight,
    userLinks: 1, connections: users, upstreamConnections: 1, size, stage: 'gateway-hold', noDelay }
  assert.equal(apps.length, users)
  assert.ok(apps.every(app => app.nact.listPeerId().length === 1))
  const readyGateway = await gateway.ask('peers'), readyUpstream = await upstream.ask('peers')
  assert.equal(readyGateway.peers, users + 1, 'Gateway must have User links plus exactly one upstream link')
  assert.equal(readyUpstream.peers, 1)
  console.log(`GATEWAY ready: ${users} independent Users → ${users} links → Gateway → 1 upstream link`)
  const warmupCfg = { ...cfg, size: 256, stage: 'gateway-warmup' }
  const warmupLabels = { provider, topology: cfg.topology, users, vus: users, connections: users,
    upstreamConnections: 1, size: 256, stage: warmupCfg.stage,
    ...(process.env.NASDK_BENCH_RUN && { run: process.env.NASDK_BENCH_RUN }) }
  meter.labels = { ...warmupLabels, role: 'client' }
  await gateway.ask('start', { labels: warmupLabels }); await upstream.ask('start', { labels: warmupLabels }); meter.start()
  console.log(`START Gateway warmup ${provider}: ${users} Users, 256B, ${warmup}s`)
  const prepared = await benchRequests(apps, warmupCfg, warmup)
  const warmupClient = meter.stop(), warmupGateway = await gateway.ask('stop'), warmupServer = await upstream.ask('stop')
  const warmupResult = { cfg: warmupCfg, ...prepared, client: warmupClient,
    gateway: warmupGateway.metrics, server: warmupServer.metrics,
    environment: { node: process.version, cpus: process.env.NASDK_BENCH_CPUS,
      httpMaxBufferedBytes: spec.provider.maxBufferedBytes, httpMaxSessions: spec.provider.maxSessions } }
  await writeFile(new URL(`gateway-${provider}-${users}-warmup-${Date.now()}.jsonl`, dir), `${JSON.stringify(warmupResult)}\n`)
  await publishResult(warmupResult)
  console.log(`GATEWAY warmup: completed=${prepared.completed}, failed=${prepared.failed}, aborted=${prepared.aborted}`)
  if (prepared.failed || prepared.aborted) console.log(`GATEWAY warmup diagnostics: ${JSON.stringify({ errors: prepared.errors,
    client: warmupClient.warnings, gateway: warmupGateway.metrics.warnings, upstream: warmupServer.metrics.warnings })}`)
  assert.equal(prepared.failed, 0, `warmup request failures: ${JSON.stringify(prepared.errors)}`)
  assert.equal(prepared.aborted, false, 'warmup drain deadline exceeded; see archived warmup diagnostics')
  const labels = { provider, topology: cfg.topology, size, stage: cfg.stage, users, vus: users,
    connections: users, upstreamConnections: 1,
    ...(process.env.NASDK_BENCH_RUN && { run: process.env.NASDK_BENCH_RUN }) }
  meter.labels = { ...labels, role: 'client' }
  await gateway.ask('start', { labels }); await upstream.ask('start', { labels }); meter.start()
  console.log(`START Gateway ${provider}: ${users} Users, ${size}B, ${duration}s`)
  const measured = await benchRequests(apps, cfg, duration)
  const client = meter.stop(), gw = await gateway.ask('stop'), srv = await upstream.ask('stop')
  const result = { cfg, ...measured, client, gateway: gw.metrics, server: srv.metrics,
    gatewayPeers: gw.peers, upstreamPeers: srv.peers,
    environment: { node: process.version, cpus: process.env.NASDK_BENCH_CPUS, queueMaxCount: positive('NASDK_CAPACITY_QUEUE_MAX_COUNT', 1024), payloadLimit, rssLimit,
      ...(provider === 'streamable-http' && { httpMaxSessions: users + 1,
        httpMaxBodyBytes: spec.provider.maxBodyBytes, httpMaxBufferedBytes: spec.provider.maxBufferedBytes }) } }
  await writeFile(new URL(`gateway-${provider}-${users}-${Date.now()}.jsonl`, dir), `${JSON.stringify(result)}\n`)
  await publishResult(result)
  console.log(`GATEWAY ${provider} ${users} Users: completed=${result.completed}, ${result.msgPerSec.toFixed(2)}/s, ${result.usefulMiBPerSec.toFixed(1)} MiB/s, P99 ${result.latencyMs.p99.toFixed(1)}ms, failed=${result.failed}, aborted=${result.aborted}`)
  if (result.failed || result.aborted) console.log(`GATEWAY warnings: ${JSON.stringify({ client: client.warnings, gateway: gw.metrics.warnings, upstream: srv.metrics.warnings })}`)
  assert.equal(result.aborted, false, JSON.stringify(result.errors))
  assert.equal(result.failed, 0, JSON.stringify(result.errors))
  assert.equal(srv.peers, 1, 'upstream connection count must remain one')
  for (const role of ['client', 'gateway', 'server']) assert.ok(result[role].rssPeakBytes < rssLimit, `${role} exceeds RSS limit`)
})
