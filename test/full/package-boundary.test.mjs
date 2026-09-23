import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

// A server-only import leaking through a public browser entry must fail the build.
for (const entry of ['index.ts', 'packages/nact-streamable-http-client/index.ts',
  'packages/nact-streamable-http-server/handler.ts', 'packages/nact-websocket-client/index.ts']) {
  test(`${entry}: browser build stays independent of server networking`, async () => {
    const result = await Bun.build({ entrypoints: [fileURLToPath(new URL(`../../${entry}`, import.meta.url))],
      target: 'browser', write: false })
    assert.equal(result.success, true, result.logs.map(String).join('\n'))
    assert.ok(result.outputs.length)
  })
}
