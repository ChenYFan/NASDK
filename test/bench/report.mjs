import { readFile, writeFile } from 'node:fs/promises'

const dir = new URL('./results/', import.meta.url)
const rows = (await readFile(new URL('native.jsonl', dir), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const requests = rows.filter(row => row.kind === 'request')
let baseline = []
if (process.env.NASDK_BENCH_BASELINE) baseline = JSON.parse(await readFile(process.env.NASDK_BENCH_BASELINE, 'utf8'))
const threshold = Number(process.env.NASDK_BENCH_REGRESSION_PERCENT ?? 20)
const comparisons = requests.map(row => {
  const previous = baseline.find(old => JSON.stringify(old.cfg) === JSON.stringify(row.cfg))
  const throughputChangePercent = previous ? (row.msgPerSec / previous.msgPerSec - 1) * 100 : null
  const latencyChangePercent = previous ? (row.latencyMs.p99 / previous.latencyMs.p99 - 1) * 100 : null
  return { cfg: row.cfg, msgPerSec: row.msgPerSec, p99: row.latencyMs.p99, throughputChangePercent, latencyChangePercent,
    regressed: previous ? throughputChangePercent < -threshold || latencyChangePercent > threshold : false }
})
await writeFile(new URL('baseline.json', dir), JSON.stringify(requests, null, 2))
await writeFile(new URL('comparison.json', dir), JSON.stringify(comparisons, null, 2))
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
const table = rows.map(row => `<tr><td>${escape(row.kind)}</td><td>${escape(row.cfg?.provider ?? row.provider)}</td>` +
  `<td>${escape(JSON.stringify(row.cfg ?? { slow: row.slow }))}</td><td>${row.completed ?? row.consumed}</td>` +
  `<td>${row.msgPerSec?.toFixed(1)}</td><td>${row.usefulMiBPerSec?.toFixed(1) ?? '-'}</td>` +
  `<td>${row.latencyMs?.p99.toFixed(2) ?? '-'}</td><td>${row.failed ?? row.dropped ?? 0}</td></tr>`).join('')
await writeFile(new URL('report.html', dir), `<!doctype html><meta charset="utf-8"><title>NASDK Performance</title>
<style>body{font:14px sans-serif;margin:30px;background:#101827;color:#eef}td,th{padding:10px;border-bottom:1px solid #456}svg{background:#182438}a{color:#8df}</style>
<h1>NASDK 性能与持续回归</h1><p>独立进程采集；本轮基础压测与 Full/Edge/k6 并行，不能与独占机器成绩直接比较。</p>
<svg viewBox="0 0 1000 220">${requests.map((r, i) => `<rect x="${30 + i * 200}" y="${190 - r.msgPerSec / Math.max(...requests.map(x => x.msgPerSec)) * 150}" width="120" height="${r.msgPerSec / Math.max(...requests.map(x => x.msgPerSec)) * 150}" fill="#56b9df"/><text x="${30 + i * 200}" y="210" fill="white">${escape(r.cfg.provider)} ${Math.round(r.msgPerSec)}/s</text>`).join('')}</svg>
<table><thead><tr><th>测试</th><th>Provider</th><th>配置</th><th>完成</th><th>msg/s</th><th>MiB/s</th><th>P99 ms</th><th>失败/丢弃</th></tr></thead><tbody>${table}</tbody></table>
<h2>基线比较</h2><pre>${escape(JSON.stringify(comparisons, null, 2))}</pre><p>完整 k6 指标见 k6-summary.json；资源趋势见 metrics.jsonl；交互看板见 Grafana。</p>`)
if (comparisons.some(row => row.regressed)) process.exitCode = 1
