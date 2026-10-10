import { spawn } from 'node:child_process'
import { appendFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function regression(suite) {
  if (!['simple', 'full', 'edge'].includes(suite)) throw new Error('Unknown regression suite')
  const begin = Date.now(), child = spawn('npm', ['run', `test:${suite}`], {
    cwd: new URL('../../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NASDK_PRESSURE: '0', NASDK_METRICS_URL: '' },
  })
  let text = ''
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', bytes => { text += bytes.toString(); target.write(bytes) })
  }
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  const count = key => [...text.matchAll(new RegExp(`(?:ℹ|#) ${key} (\\d+)`, 'g'))].reduce((n, m) => n + Number(m[1]), 0)
  const result = { suite, success: code === 0, elapsedSeconds: (Date.now() - begin) / 1000,
    passed: count('pass'), failed: count('fail'), skipped: count('skipped') }
  const url = process.env.NASDK_METRICS_URL ?? 'http://127.0.0.1:18991'
  const response = await fetch(`${url}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels: { role: 'regression', suite, result_id: randomUUID() }, values: {
      regression_success: Number(result.success), regression_passed: result.passed, regression_failed: result.failed,
      regression_skipped: result.skipped, regression_duration_seconds: result.elapsedSeconds }, result }) })
  if (!response.ok) throw new Error('Regression result upload failed')
  await appendFile(new URL('./results/regression.jsonl', import.meta.url), `${JSON.stringify(result)}\n`)
  if (code !== 0) throw new Error(`${suite} regression failed: ${code}`)
}
if (process.argv[2]) await regression(process.argv[2])
