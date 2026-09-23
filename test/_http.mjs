import { createServer } from 'node:http'
import { createApp, toNodeListener } from 'h3'
import NApp from '../index.ts'
import HTTPServer from '../packages/nact-streamable-http-server/index.ts'
import HTTPClient from '../packages/nact-streamable-http-client/index.ts'
import NextJSProvider from '../packages/nact-nextjs/index.ts'
import NuxtProvider from '../packages/nact-nuxt/index.ts'
import { makeNaceb, makeNacab } from './_kit.mjs'

export async function httpPair(kind, serverOptions = {}, clientOptions = {}) {
  const Provider = { http: HTTPServer, next: NextJSProvider, nuxt: NuxtProvider }[kind]
  const provider = new Provider()
  const options = kind === 'http' ? { host: '127.0.0.1', port: 19081, ...serverOptions } : serverOptions
  const srv = new NApp({ id: 'srv', server: [{ type: 'streamable-http', provider: options }] })
  srv.nact.use(provider)
  srv.bindProcessor('ability', makeNacab().nacpAdaptor)
  srv.bindProcessor('event', makeNaceb().nacpAdaptor)
  await srv.start()
  let url, host
  if (kind === 'http') url = 'http://127.0.0.1:19081/nacp'
  if (kind === 'next') {
    const handlers = provider.routeHandlers()
    host = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: request => handlers[request.method]?.(request) ?? new Response(null, { status: 405 }), idleTimeout: 0 })
    url = `http://127.0.0.1:${host.port}/api/nacp`
  }
  if (kind === 'nuxt') {
    const h3 = createApp()
    h3.use('/api/nacp', provider.handler())
    host = createServer(toNodeListener(h3))
    await new Promise(resolve => host.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${host.address().port}/api/nacp`
  }
  const cli = new NApp({ id: 'cli' })
  cli.nact.use(new HTTPClient())
  await cli.start()
  const stop = async () => {
    await cli.terminate()
    await srv.terminate()
    if (kind === 'next') await host.stop(true)
    if (kind === 'nuxt') {
      const closed = new Promise(resolve => host.close(resolve))
      host.closeAllConnections(); await closed
    }
  }
  try {
    await cli.connect('srv', { type: 'streamable-http', provider: { url, ...clientOptions } })
    return { srv, cli, provider, url, stop }
  } catch (reason) { await stop(); throw reason }
}
