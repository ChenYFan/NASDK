import TCPServerProvider from '../packages/nact-tcp-server/index.ts'
import TCPClientProvider from '../packages/nact-tcp-client/index.ts'
import UnixServerProvider from '../packages/nact-unix-server/index.ts'
import UnixClientProvider from '../packages/nact-unix-client/index.ts'
import WebSocketServerProvider from '../packages/nact-websocket-server/index.ts'
import WebSocketClientProvider from '../packages/nact-websocket-client/index.ts'

export function useProviders(app) {
  for (const Provider of [TCPServerProvider, TCPClientProvider, UnixServerProvider,
    UnixClientProvider, WebSocketServerProvider, WebSocketClientProvider]) app.nact.use(new Provider())
  return app
}

export function clientSpec(spec) {
  if (spec.type !== 'websocket') return spec
  return { ...spec, provider: { url: `ws://${spec.provider.host}:${spec.provider.port}${spec.provider.path ?? '/'}` } }
}
