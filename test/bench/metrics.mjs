import http from 'node:http'
import { mkdir, appendFile, readFile } from 'node:fs/promises'

const series = new Map()
const run = process.env.NASDK_BENCH_RUN ?? new Date().toISOString()
const git = process.env.NASDK_BENCH_SHA ?? 'working-tree'
const archive = process.env.NASDK_METRICS_ARCHIVE ?? new URL('./results/', import.meta.url).pathname
await mkdir(archive, { recursive: true })
try {
  for (const line of (await readFile(`${archive}/results-metrics.jsonl`, 'utf8')).split('\n').filter(Boolean)) {
    const entry = JSON.parse(line)
    series.set(JSON.stringify(entry.labels), entry)
  }
} catch (error) { if (error.code !== 'ENOENT') throw error }
const escape = value => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
const labels = object => `{${Object.entries(object).map(([key, value]) => `${key}="${escape(value)}"`).join(',')}}`
export function renderMetrics() {
  const lines = []
  for (const entry of series.values()) {
    const tags = { run, git, ...entry.labels }
    for (const [name, value] of Object.entries(entry.values ?? {})) {
      if (/^[a-z_][a-z0-9_]*$/.test(name) && Number.isFinite(value)) lines.push(`nasdk_bench_${name}${labels(tags)} ${value}`)
    }
    if (entry.histogram) {
      const h = entry.histogram
      h.bounds.forEach((le, i) => lines.push(`nasdk_bench_latency_seconds_bucket${labels({ ...tags, le })} ${h.buckets[i]}`))
      lines.push(`nasdk_bench_latency_seconds_bucket${labels({ ...tags, le: '+Inf' })} ${h.count}`)
      lines.push(`nasdk_bench_latency_seconds_count${labels(tags)} ${h.count}`)
      lines.push(`nasdk_bench_latency_seconds_sum${labels(tags)} ${h.sum}`)
    }
  }
  return `${lines.join('\n')}\n`
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/metrics') { res.setHeader('content-type', 'text/plain; version=0.0.4'); res.end(renderMetrics()); return }
    if (req.method !== 'POST' || req.url !== '/ingest') { res.writeHead(404).end(); return }
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('metrics body too large'); chunks.push(chunk) }
    const entry = JSON.parse(Buffer.concat(chunks))
    if (entry.labels?.role === 'result' || entry.labels?.role === 'regression') {
      entry.labels = { run, git, ...entry.labels }
      await appendFile(`${archive}/results-metrics.jsonl`, `${JSON.stringify(entry)}\n`)
    }
    series.set(JSON.stringify(entry.labels), entry)
    if (process.env.NASDK_METRICS_ARCHIVE) {
      await mkdir(process.env.NASDK_METRICS_ARCHIVE, { recursive: true })
      await appendFile(`${process.env.NASDK_METRICS_ARCHIVE}/metrics.jsonl`, `${JSON.stringify({ time: Date.now(), ...entry })}\n`)
    }
    res.writeHead(204).end()
  } catch (error) { res.writeHead(400).end(error.message) }
})
server.listen(Number(process.env.NASDK_METRICS_PORT ?? 18991), '0.0.0.0', () => console.log('metrics collector ready'))
process.on('SIGTERM', () => server.close())
