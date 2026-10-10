import { spawn, execFileSync } from 'node:child_process'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { providers } from './providers.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

const { values: args } = parseArgs({ options: Object.fromEntries([
  'stage', 'cpus', 'provider', 'size', 'inflight', 'connections', 'rate', 'mode', 'duration', 'warmup', 'http-rate', 'ws-vus',
  'vu-steps', 'vu-ramp', 'vu-hold', 'ws-inflight', 'vus', 'vu-inflight',
  'connection-steps', 'payload-limit-mib', 'rss-limit-mib', 'queue-max-count', 'http-buffer-mib',
].map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean' }], ['dry-run', { type: 'boolean' }], ['nodelay', { type: 'boolean' }], ['k6-regression', { type: 'boolean' }]])) })
const supported = ['echo', 'k6', 'native', 'matrix', 'gateway', 'scan', 'hold', 'arrival', 'recovery', 'k6-http', 'k6-ws', 'k6-http-vu', 'k6-ws-vu', 'regression', 'mixed']
if (args.help) {
  console.log(`Usage: npm run test:bench -- echo|gateway|k6 --cpus <list> --provider ${providers.join('|')}
Load: --vus <count> --connections <count> --vu-inflight <count> --size <bytes> --duration <seconds> --warmup <seconds>.
Matrix: --vu-steps <list> --connection-steps <list>; limits: --payload-limit-mib <MiB> --rss-limit-mib <MiB> --http-buffer-mib <MiB>.
Stages: ${supported.join(', ')}; --dry-run prints configuration; metrics use NASDK_METRICS_URL.`)
} else {
  const stages = (args.stage ?? 'echo').split(',')
  if (stages.includes('all')) stages.splice(0, stages.length, 'native', 'k6-http', 'k6-ws', 'regression')
  for (const stage of stages) if (!supported.includes(stage)) throw new Error(`Unknown stage: ${stage}`)
  const cpus = args.cpus ?? process.env.NASDK_BENCH_CPUS
  if (!cpus || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(cpus)) throw new Error('Set --cpus or NASDK_BENCH_CPUS explicitly')
  for (const key of ['size', 'inflight', 'connections', 'rate', 'duration', 'warmup', 'http-rate', 'ws-vus', 'vu-ramp', 'vu-hold', 'ws-inflight', 'vus', 'vu-inflight', 'payload-limit-mib', 'rss-limit-mib', 'queue-max-count', 'http-buffer-mib']) {
    if (args[key] !== undefined && (!Number.isSafeInteger(Number(args[key])) || Number(args[key]) < 1)) throw new Error(`--${key} must be a positive integer`)
  }
  if (args['vu-steps'] && !/^\d+(,\d+)*$/.test(args['vu-steps'])) throw new Error('--vu-steps must contain comma-separated positive integers')
  if (args['vu-steps']?.split(',').some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw new Error('Invalid VU level')
  if (args.inflight && (args.vus || args['vu-inflight'] || args['vu-steps'])) throw new Error('Use --vu-inflight with VU parameters instead of --inflight')
  if (args.vus && args['vu-steps']) throw new Error('Choose --vus or --vu-steps')
  if (args['connection-steps'] && (!/^\d+(,\d+)*$/.test(args['connection-steps']) || args['connection-steps'].split(',').some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 1))) throw new Error('Invalid connection steps')
  if (args['connection-steps'] && !stages.includes('matrix')) throw new Error('--connection-steps requires --stage matrix')
  if (stages.includes('matrix') && (args.rate || args.inflight)) throw new Error('matrix uses closed-loop VUs; use --vu-inflight, without --rate or --inflight')
  if (args.duration && stages.some(stage => stage.endsWith('-vu'))) throw new Error('VU stages use --vu-ramp and --vu-hold instead of --duration')
  if (stages.includes('arrival') && !args.rate && !process.env.NASDK_CAPACITY_RATE) throw new Error('Standalone arrival requires --rate')
  const dir = new URL('./results/', import.meta.url)
  await mkdir(dir, { recursive: true })
  const run = new Date().toISOString(), sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const affinity = execFileSync('taskset', ['-c', cpus, 'sh', '-c', 'taskset -pc $$'], { encoding: 'utf8' }).trim()
  const env = { ...process.env, NASDK_BENCH_CPUS: cpus, NASDK_BENCH_RUN: run, NASDK_BENCH_SHA: sha,
    NASDK_METRICS_URL: process.env.NASDK_METRICS_URL ?? 'http://127.0.0.1:18991' }
  for (const [arg, name] of Object.entries({ provider: 'PROVIDER', size: 'SIZE', inflight: 'INFLIGHT', connections: 'CONNECTIONS', rate: 'RATE', mode: 'MODE',
    vus: 'VUS', 'vu-inflight': 'VU_INFLIGHT', 'vu-steps': 'VU_STEPS',
    'payload-limit-mib': 'PAYLOAD_LIMIT_MIB', 'rss-limit-mib': 'RSS_LIMIT_MIB', 'queue-max-count': 'QUEUE_MAX_COUNT', 'http-buffer-mib': 'HTTP_BUFFER_MIB' })) {
    if (args[arg]) env[`NASDK_CAPACITY_${name}`] = args[arg]
  }
  if (args.nodelay) env.NASDK_BENCH_NODELAY = '1'
  env.NASDK_CAPACITY_SCAN_SECONDS = args.duration ?? env.NASDK_CAPACITY_SCAN_SECONDS ?? '30'
  env.NASDK_CAPACITY_HOLD_SECONDS = args.duration ?? env.NASDK_CAPACITY_HOLD_SECONDS ?? '60'
  env.NASDK_CAPACITY_ARRIVAL_SECONDS = args.duration ?? env.NASDK_CAPACITY_ARRIVAL_SECONDS ?? '120'
  env.NASDK_CAPACITY_RECOVERY_SECONDS = args.duration ?? env.NASDK_CAPACITY_RECOVERY_SECONDS ?? '30'
  env.NASDK_CAPACITY_WARMUP_SECONDS = args.warmup ?? '30'
  const gatewayMode = stages.includes('gateway')
  if (gatewayMode && stages.length !== 1) throw new Error('Run Gateway topology as a standalone stage')
  if (gatewayMode && (args.connections || args['connection-steps'] || args.rate || args.inflight)) throw new Error('Gateway uses one link per User and one upstream link; specify --vus or --vu-steps')
  const matrix = stages.includes('matrix') || gatewayMode ? (args.provider ?? 'unix,tcp,websocket').split(',').flatMap(provider =>
    (gatewayMode ? '1' : args['connection-steps'] ?? args.connections ?? '4,16').split(',').flatMap(connections =>
      (args['vu-steps'] ?? args.vus ?? '1024,4096,16384').split(',').map(vus => ({ provider,
        connections: Number(connections), vus: Number(vus), vuInflight: Number(args['vu-inflight'] ?? 1),
        size: Number(args.size ?? 65536), seconds: Number(args.duration ?? 120),
        ...(gatewayMode && { topology: 'gateway-mux', users: Number(vus), connections: Number(vus), upstreamConnections: 1 }) })))) : []
  for (const cfg of matrix) {
    if (!providers.includes(cfg.provider)) throw new Error(`Unsupported matrix provider: ${cfg.provider}`)
    if (!args['payload-limit-mib'] || !args['rss-limit-mib']) throw new Error('matrix requires explicit --payload-limit-mib and --rss-limit-mib')
    if (cfg.size * cfg.vus * cfg.vuInflight > Number(args['payload-limit-mib']) * 1048576) throw new Error(`Matrix payload limit too small for ${cfg.vus} VU`)
  }
  const plan = { run, sha, stages, cpus, verifiedAffinity: affinity, parameters: args, matrix,
    scope: 'load and target share logical CPU set, inherited by child threads; monitoring and kernel excluded' }
  await writeFile(new URL('large-plan.json', dir), JSON.stringify(plan, null, 2))
  const runId = run.replaceAll(':', '-')
  await writeFile(new URL(`large-plan-${runId}.json`, dir), JSON.stringify(plan, null, 2))
  console.log(JSON.stringify(plan, null, 2))
  if (!args['dry-run']) {
    const health = await fetch(`${env.NASDK_METRICS_URL}/metrics`, { signal: AbortSignal.timeout(2000) })
    if (!health.ok) throw new Error('Metrics collector unavailable')
    const children = new Set(), statuses = []
    let cancelled = false
    function launch(command, extra = {}, container = false) {
      const executable = container ? command : ['taskset', '-c', cpus, ...command]
      const child = spawn(executable[0], executable.slice(1), { cwd: root, stdio: 'inherit', env: { ...env, ...extra }, detached: true })
      children.add(child)
      const done = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => { children.delete(child); code === 0 ? resolve() : reject(new Error(`${command[0]} exited ${code ?? signal}`)) })
      })
      done.catch(() => {})
      return { child, done }
    }
    const stop = child => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
    const cancel = () => { for (const child of children) stop(child) }
    const interrupt = () => { cancelled = true; cancel() }
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
    async function regress() {
      for (const suite of ['simple', 'full', 'edge']) await launch(['node', 'test/bench/regression.mjs', suite]).done
    }
    async function native(stage) {
      const provider = args.provider ?? 'tcp'
      if (![...providers, 'nacp-direct'].includes(provider)) throw new Error(`Unsupported Echo provider: ${provider}`)
      await launch(['node', '--import', 'tsx', '--test', '--test-isolation=none', 'test/bench/echo.test.mjs'], {
        NASDK_PRESSURE: '1', NASDK_CAPACITY_PROVIDER: provider,
        NASDK_CAPACITY_STAGES: stage === 'native' ? 'scan,hold,arrival,recovery' : stage === 'echo' ? 'hold' : stage,
      }).done
    }
    async function runMatrix() {
      const failures = []
      for (const [index, cfg] of matrix.entries()) {
        if (cancelled) throw new Error('Matrix interrupted')
        const stage = `${gatewayMode ? 'gateway' : 'matrix'}-${cfg.provider}-${cfg.connections}conn-${cfg.vus}vu`, begin = Date.now()
        console.log(`MATRIX ${index + 1}/${matrix.length} ${stage}: ${cfg.size}B, ${cfg.seconds}s`)
        let status
        try {
          await launch(['node', '--import', 'tsx', '--test', '--test-isolation=none', `test/bench/${gatewayMode ? 'gateway' : 'echo'}.test.mjs`], {
            NASDK_PRESSURE: '1',
            NASDK_CAPACITY_STAGES: 'hold', NASDK_CAPACITY_PROVIDER: cfg.provider,
            NASDK_CAPACITY_CONNECTIONS: String(cfg.connections), NASDK_CAPACITY_VUS: String(cfg.vus),
            NASDK_CAPACITY_VU_INFLIGHT: String(cfg.vuInflight), NASDK_CAPACITY_SIZE: String(cfg.size),
            NASDK_CAPACITY_HOLD_SECONDS: String(cfg.seconds), NASDK_CAPACITY_INFLIGHT: '', NASDK_CAPACITY_VU_STEPS: '',
          }).done
          status = { stage, cfg, success: true, seconds: (Date.now() - begin) / 1000 }
        } catch (error) {
          status = { stage, cfg, success: false, error: error.message, seconds: (Date.now() - begin) / 1000 }
          failures.push(error)
        }
        statuses.push(status)
        await writeFile(new URL(`large-status-${runId}.json`, dir), JSON.stringify({ ...plan, statuses }, null, 2))
      }
      if (failures.length) throw new AggregateError(failures, `${failures.length}/${matrix.length} matrix cases failed; inspect individual results`)
    }
    async function k6(scenario, concurrentNative = false, vu = false) {
      const target = launch(['node', '--import', 'tsx', 'test/bench/target.mjs'])
      const containerName = `nasdk-k6-${process.pid}-${scenario}`
      try {
        for (let i = 0; i < 100; i++) {
          try { if ((await fetch('http://127.0.0.1:18992/health')).ok) break } catch {}
          if (i === 99) throw new Error('k6 target unavailable')
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        await build({ absWorkingDir: root, entryPoints: [stages.includes('k6') ? 'test/bench/k6/basic.mjs' : 'test/bench/k6.mjs'], outfile: 'test/bench/results/k6.bundle.js', bundle: true,
          format: 'esm', platform: 'browser', external: ['k6', 'k6/*'] })
        const filename = `k6-${scenario}-${Date.now()}.json`
        const command = ['docker', 'run', '--rm', '--name', containerName, '--cpuset-cpus', cpus, '--network', 'host',
          '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, '-v', `${dir.pathname}:/results`,
          '-e', `DURATION=${args.duration ?? (stages.includes('k6') ? 10 : 1800)}s`, '-e', `K6_SCENARIO=${scenario === 'both' ? '' : scenario}`,
          '-e', `HTTP_RATE=${args['http-rate'] ?? args.rate ?? 50}`, '-e', `WS_VUS=${args['ws-vus'] ?? 4}`,
          '-e', `PAYLOAD_BYTES=${args.size ?? 4096}`, '-e', `K6_SUMMARY=/results/${filename}`,
          '-e', `VU_STEPS=${vu ? args['vu-steps'] ?? '1,4,16,64' : ''}`,
          '-e', `VU_RAMP_SECONDS=${args['vu-ramp'] ?? 15}`, '-e', `VU_HOLD_SECONDS=${args['vu-hold'] ?? 60}`,
          '-e', `WS_INFLIGHT=${args['ws-inflight'] ?? 1}`,
          '-e', `WS_SESSION_MS=${vu ? 86400000 : 5000}`,
          '-e', 'K6_PROMETHEUS_RW_SERVER_URL=http://127.0.0.1:18994/api/v1/write',
          '-e', 'K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),max',
          env.K6_IMAGE ?? 'grafana/k6:1.3.0', 'run',
          '--tag', `run=${run}`, '--tag', `stage=k6-${scenario}${vu ? '-vu' : ''}`, '-o', 'experimental-prometheus-rw', '/results/k6.bundle.js']
        const jobs = [launch(command, {}, true).done]
        if (concurrentNative || args['k6-regression']) jobs.push(regress())
        if (concurrentNative) jobs.push(native('hold'))
        const results = await Promise.allSettled(jobs)
        let summary
        try { summary = JSON.parse(await readFile(new URL(filename, dir), 'utf8')) } catch {}
        const uploaded = await fetch(`${env.NASDK_METRICS_URL}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ labels: { role: 'regression', suite: `k6-${scenario}${vu ? '-vu' : ''}`, run }, values: {
            regression_success: Number(results[0].status === 'fulfilled'),
            regression_passed: summary?.root_group.checks.reduce((n, c) => n + c.passes, 0) ?? 0,
            regression_failed: summary?.root_group.checks.reduce((n, c) => n + c.fails, 0) ?? 0 }, result: summary }) })
        if (!uploaded.ok) throw new Error('k6 result upload failed')
        const failures = results.filter(r => r.status === 'rejected').map(r => r.reason)
        if (failures.length) throw new AggregateError(failures, `k6 ${scenario} stage failed: ${failures.map(error => error.message).join('; ')}`)
      } finally {
        // Docker daemon owns the container; killing the docker client alone is insufficient.
        try { execFileSync('docker', ['stop', '-t', '2', containerName], { stdio: 'ignore' }) } catch {}
        stop(target.child)
        await target.done.catch(() => {})
      }
    }
    try {
      for (const stage of stages) {
        if (cancelled) throw new Error('Large run interrupted')
        const begin = Date.now()
        try {
          if (stage === 'matrix' || stage === 'gateway') await runMatrix()
          else if (stage === 'k6') await k6('both')
          else if (stage === 'regression') await regress()
          else if (stage === 'k6-http') await k6('http')
          else if (stage === 'k6-ws') await k6('ws')
          else if (stage === 'k6-http-vu') await k6('http', false, true)
          else if (stage === 'k6-ws-vu') await k6('ws', false, true)
          else if (stage === 'mixed') await k6('both', true)
          else await native(stage)
          statuses.push({ stage, success: true, seconds: (Date.now() - begin) / 1000 })
        } catch (error) {
          statuses.push({ stage, success: false, error: error.message, seconds: (Date.now() - begin) / 1000 })
          throw error
        }
      }
    } catch (error) {
      if (!cancelled) throw error
      console.log('Large run interrupted; remaining cases cancelled.')
      process.exitCode = 130
    } finally {
      cancel()
      for (const status of statuses) {
        const response = await fetch(`${env.NASDK_METRICS_URL}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ labels: { role: 'regression', suite: `large-${status.stage}`, run }, values: {
            regression_success: Number(status.success), regression_duration_seconds: status.seconds }, result: status }) })
        if (!response.ok) process.exitCode = 1
      }
      await writeFile(new URL('large-status.json', dir), JSON.stringify({ ...plan, statuses }, null, 2))
      await writeFile(new URL(`large-status-${runId}.json`, dir), JSON.stringify({ ...plan, statuses }, null, 2))
    }
  }
}
