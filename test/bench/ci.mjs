import { spawn, execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const root = new URL('../../', import.meta.url)
const results = new URL('./results/', import.meta.url)
await mkdir(results, { recursive: true })
const run = new Date().toISOString(), sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const env = { ...process.env, NASDK_BENCH_RUN: run, NASDK_BENCH_SHA: sha,
  NASDK_METRICS_URL: 'http://127.0.0.1:18991', NASDK_METRICS_ARCHIVE: results.pathname }
for (const file of ['native.jsonl', 'metrics.jsonl']) await writeFile(new URL(file, results), '')
const children = new Set()
function start(args, extra = {}) {
  const child = spawn(args[0], args.slice(1), { cwd: root, env: { ...env, ...extra }, stdio: 'inherit' })
  children.add(child)
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { children.delete(child); code === 0 ? resolve() : reject(new Error(`${args.join(' ')}: ${code ?? signal}`)) })
  })
  done.catch(() => {})
  return { child, done }
}
async function ready(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`service unavailable: ${url}`)
}
try {
  start(['node', 'test/bench/metrics.mjs']); await ready(`${env.NASDK_METRICS_URL}/metrics`)
  start(['node', '--import', 'tsx', 'test/bench/target.mjs']); await ready('http://127.0.0.1:18992/health')
  await build({ absWorkingDir: root.pathname, entryPoints: ['test/bench/k6/basic.mjs'], outfile: 'test/bench/results/k6.bundle.js', bundle: true,
    format: 'esm', platform: 'browser', external: ['k6', 'k6/*'], define: { 'process.env.NODE_ENV': '"production"' } })
  const duration = process.env.NASDK_BENCH_DURATION ?? '10'
  const jobs = [
    start(['node', '--import', 'tsx', '--test', 'test/bench/profiles.test.mjs'], { NASDK_PRESSURE: '1',
      NASDK_BENCH_PROFILE: process.env.NASDK_BENCH_PROFILE ?? 'steady', NASDK_BENCH_DURATION: duration,
      NASDK_BENCH_WARMUP: process.env.NASDK_BENCH_WARMUP ?? '2', NASDK_BENCH_REPEATS: process.env.NASDK_BENCH_REPEATS ?? '1',
      NASDK_BENCH_OUTPUT: `${results.pathname}native.jsonl` }).done,
    start(['node', 'test/bench/regression.mjs', 'simple']).done,
    start(['node', 'test/bench/regression.mjs', 'full']).done,
    start(['node', 'test/bench/regression.mjs', 'edge']).done,
    start(['docker', 'run', '--rm', '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, '--network', 'host', '-v', `${results.pathname}:/results`,
      '-e', `DURATION=${Number(duration) * 3}s`, '-e', 'K6_SUMMARY=/results/k6-summary.json',
      '-e', 'K6_PROMETHEUS_RW_SERVER_URL=http://127.0.0.1:18994/api/v1/write',
      '-e', 'K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),max',
      process.env.K6_IMAGE ?? 'grafana/k6:1.3.0', 'run', '-o', 'experimental-prometheus-rw', '/results/k6.bundle.js']).done,
  ]
  const settled = await Promise.allSettled(jobs)
  const summary = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(new URL('k6-summary.json', results), 'utf8')))
  const checks = summary.root_group.checks ?? []
  await fetch(`${env.NASDK_METRICS_URL}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels: { role: 'regression', suite: 'k6', run }, values: {
      regression_success: Number(settled.at(-1).status === 'fulfilled'),
      regression_passed: checks.reduce((n, c) => n + c.passes, 0), regression_failed: checks.reduce((n, c) => n + c.fails, 0) }, result: summary }) })
  await writeFile(new URL('run.json', results), JSON.stringify({ run, sha,
    jobs: settled.map(result => ({ status: result.status, error: result.reason?.message })) }, null, 2))
  await start(['node', 'test/bench/report.mjs']).done
  const failures = settled.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'benchmark/regression failed')
} finally {
  for (const child of children) child.kill('SIGTERM')
}
