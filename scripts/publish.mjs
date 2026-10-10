import { spawnSync } from 'node:child_process'

// npm publish invokes the publish lifecycle too; only npm run publish starts publishing.
if (process.env.npm_command === 'run-script') {
  const cwd = new URL('../', import.meta.url)
  for (const args of [['run', 'build'], ['publish', ...process.argv.slice(2)]]) {
    const result = spawnSync('npm', args, { cwd, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
  }
}
