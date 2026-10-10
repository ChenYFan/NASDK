import { spawnSync } from 'node:child_process'

const [action, ...rest] = process.argv.slice(2)
const tools = { prepare: 'dashboard', metrics: 'metrics', grafana: 'grafana', upload: 'upload', regression: 'regression', ci: 'ci' }
const root = new URL('../../', import.meta.url)
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (action === '--help' || action === 'help') {
  console.log('test:bench [echo|gateway|k6] --cpus <list> [options]\ntest:bench prepare|up|down|metrics|grafana|upload|regression|ci [arguments]')
  run('node', ['test/bench/runner.mjs', '--help'])
} else if (action === 'up' || action === 'down') {
  if (action === 'up') run('node', ['test/bench/dashboard.mjs'])
  run('docker', ['compose', '-p', 'nasdk-bench', '-f', 'test/bench/compose.yml', ...(action === 'up' ? ['up', '-d'] : ['down']), ...rest])
} else if (tools[action]) {
  if (action === 'grafana') run('node', ['test/bench/dashboard.mjs'])
  run('node', [`test/bench/${tools[action]}.mjs`, ...rest])
} else {
  run('node', ['test/bench/runner.mjs', ...(['echo', 'gateway', 'k6'].includes(action)
    ? ['--stage', action, ...rest] : process.argv.slice(2))])
}
