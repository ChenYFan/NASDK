import assert from 'node:assert/strict'
import NApp from '../index.ts'
import Client from '../packages/nact-streamable-http-client/index.ts'

const root = new URL('../', import.meta.url).pathname
async function run(cmd, cwd) {
  const process = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit',
    env: { ...Bun.env, NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1' } })
  assert.equal(await process.exited, 0, cmd.join(' '))
}
await run(['bun', 'run', 'build'], root)
for (const [name, id, port] of [['nextjs', 'next', 19101], ['nuxt', 'nuxt', 19102]]) {
  const cwd = `${root}examples/${name}`
  await run(['bun', 'install', '--frozen-lockfile'], cwd)
  await run(['bun', 'run', 'build'], cwd)
  const cmd = name === 'nextjs'
    ? ['bun', '--bun', 'next', 'start', '-p', String(port), '-H', '127.0.0.1']
    : ['bun', '.output/server/index.mjs']
  const server = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit',
    env: { ...Bun.env, PORT: String(port), HOST: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1' } })
  const app = new NApp({ id: `smoke-${id}` })
  app.nact.use(new Client())
  try {
    const url = `http://127.0.0.1:${port}/api/nacp`
    const deadline = Date.now() + 30_000
    for (;;) {
      if (server.exitCode !== null) throw new Error(`${name} server exited: ${server.exitCode}`)
      try {
        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(1000) })
        await response.body?.cancel()
        if (response.status === 404) break // mounted route, unknown session
      } catch { /* waiting for listener */ }
      if (Date.now() >= deadline) throw new Error(`${name} startup timed out`)
      await Bun.sleep(100)
    }
    await app.start()
    await app.connect(id, { type: 'streamable-http', provider: { url } })
    const bytes = Uint8Array.from({ length: 100_000 }, (_, n) => n % 256)
    const result = await Promise.all(Array.from({ length: 8 }, (_, n) =>
      app.request(id, { kind: 'ability', target: 'echo', payload: { n, bytes } }).response))
    result.forEach((response, n) => assert.deepEqual(response.payload, { n, bytes }))
    assert.equal(await app.disconnect(id), true)
    assert.deepEqual(app.nact.listPeerId(), [])
    console.log(`${name}: production route, binary RPC, concurrency and disconnect passed`)
  } finally {
    await app.terminate()
    server.kill('SIGTERM')
    const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
    await server.exited
    clearTimeout(timer)
  }
}
