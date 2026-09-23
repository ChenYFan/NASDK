import NApp, { NACAB } from '../../../../../dist/index.js'
import NextJSProvider from '@chenyfan/nact-nextjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Keep one NApp per process, including development route reloads.
const key = Symbol.for('nasdk.next.example')
globalThis[key] ??= (async () => {
  const provider = new NextJSProvider()
  const app = new NApp({ id: 'next', server: [{ type: 'streamable-http', provider: {} }] })
  const abilities = new NACAB()
  abilities.register({ name: 'echo', description: 'Echo binary payload', execute: value => value })
  app.bindProcessor('ability', abilities.nacpAdaptor)
  app.nact.use(provider)
  await app.start()
  return { app, handlers: provider.routeHandlers() }
})()

export async function GET(request) { return (await globalThis[key]).handlers.GET(request) }
export async function POST(request) { return (await globalThis[key]).handlers.POST(request) }
export async function DELETE(request) { return (await globalThis[key]).handlers.DELETE(request) }
