import { createHash } from 'node:crypto'

export async function publishResult(result, url = process.env.NASDK_METRICS_URL) {
  if (!url) return
  const cfg = result.cfg ?? {}, provider = cfg.provider ?? result.provider ?? 'unknown'
  const kind = result.kind ?? 'request', stage = cfg.stage ?? kind, mode = cfg.mode ?? kind
  const connections = cfg.connections ?? result.connections ?? 1
  const vus = cfg.vus ?? result.vus ?? connections
  const vuInflight = cfg.vuInflight ?? result.vuInflight ?? cfg.inflight ?? 1
  const labels = { role: 'result', provider, mode, size: cfg.size ?? 256, connections: cfg.connections ?? result.connections ?? 1,
    vus, vuInflight, totalInflight: vus * vuInflight,
    topology: cfg.topology ?? 'direct', upstreamConnections: cfg.upstreamConnections ?? 0,
    inflight: cfg.inflight ?? cfg.maxInflightPerConnection ?? 1, stage, repeat: result.repeat ?? 1, noDelay: cfg.noDelay ?? false,
    ...(process.env.NASDK_BENCH_RUN && { run: process.env.NASDK_BENCH_RUN }),
    ...(process.env.NASDK_BENCH_SHA && { git: process.env.NASDK_BENCH_SHA }),
    result_id: createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 16),
    scenario: `${cfg.topology ?? 'direct'} | ${provider} | ${mode} | ${cfg.size ?? 256}B | ${vus} VU / ${connections} conn / ${vuInflight} in-flight per VU | ${stage}${cfg.noDelay ? ' NODELAY' : ''}` }
  const values = { result_msg_per_sec: result.msgPerSec ?? 0, result_p99_ms: result.latencyMs?.p99 ?? 0,
    result_useful_mib_per_sec: result.usefulMiBPerSec ?? 0, result_failed: result.failed ?? 0,
    result_dropped: result.dropped ?? 0, result_missed: result.missed ?? 0, result_completed: result.completed ?? result.consumed ?? 0,
    result_aborted: Number(result.aborted ?? false) }
  for (const [key, value] of Object.entries(result)) if (typeof value === 'number') {
    values[`result_${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`] = value
  }
  for (const role of ['client', 'gateway', 'server']) {
    const metrics = result[role]
    if (!metrics) continue
    for (const [key, value] of Object.entries(metrics)) if (typeof value === 'number') {
      values[`result_${role}_${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`] = value
    }
  }
  const response = await fetch(`${url}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels, values, result }), signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`Result upload failed: ${response.status}`)
}
