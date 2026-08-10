/**
 * NACT ws carrier — dial (browser + Node) and listen (Node only).
 *
 * The two halves have OPPOSITE portability, which is the whole shape of this file:
 *
 *   dialWs   — uses the global `WebSocket` constructor. Standard in browsers, and global in Node ≥22. No
 *              import at all, so a browser bundle takes it as-is.
 *   listenWs — needs `node:http` (the upgrade host) and `ws`'s WebSocketServer. Neither exists in a browser,
 *              and "server" is not a thing a browser can be.
 *
 * So `listenWs` reaches its Node-only dependencies through a DYNAMIC import, awaited inside the function body.
 * That is deliberate and is the load-bearing detail: a bundler resolves STATIC imports eagerly, so a top-level
 * `import http from 'node:http'` here would break a browser build even though the browser never calls listen.
 * A dynamic import inside a never-called function is not on any reachable path, so it drops out.
 *
 * A browser cannot listen at all, and the layer above refuses that earlier: `NACT.listen` throws
 * `browser-no-server` before reaching this module. This function's own Node-only-ness is the second line of
 * defence, not the first.
 */

import type { PeerHost } from './peer.ts'
import type { Peer, ServerHandle, TransportSpec } from './types.ts'
import { makeWsPeer, type WSLike } from './peer.ws.ts'
import { MAX_FRAME_SIZE } from './framing.ts'

/** Dial a ws peer. BROWSER-SAFE — `WebSocket` is taken off the global, so nothing is imported.
 *
 *  The `maxPayload` / `perMessageDeflate` options the Node side passes are `ws` extensions with no browser
 *  equivalent, so they are simply not passed: a browser enforces its own frame limits, and NACT re-checks
 *  `totalSize` against MAX_FRAME_SIZE on every fragment anyway. */
export async function dialWs(
  host: PeerHost,
  spec: Extract<TransportSpec, { type: 'ws' }>,
  chunkSize: number,
  heartbeat: number | undefined,
): Promise<Peer> {
  const url = `ws://${spec.opt.ip}:${spec.opt.port}${spec.opt.path ?? ''}`
  const ws = new WebSocket(url) as unknown as WSLike & {
    addEventListener(t: string, cb: (ev: any) => void): void
    removeEventListener(t: string, cb: (ev: any) => void): void
  }
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve() }
    const onErr = (ev: any) => { cleanup(); reject(ev?.error ?? new Error('ws dial failed')) }
    const cleanup = () => { ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onErr) }
    ws.addEventListener('open', onOpen)
    ws.addEventListener('error', onErr)
  })
  return makeWsPeer(host, ws, chunkSize, heartbeat)
}

/** Expose a ws entry. NODE ONLY — see the file header for why the imports are dynamic.
 *
 *  NACT owns its http server. There is deliberately no "borrow an external http server" form — a host that
 *  already terminated the upgrade itself (Nitro/h3 + crossws, say) has nothing left for NACT to do, so that
 *  path skips this layer entirely and hands its own Peer straight to NACP.inbound. */
export async function listenWs(
  host: PeerHost,
  spec: Extract<TransportSpec, { type: 'ws' }>,
  chunkSize: number,
  heartbeat: number | undefined,
  onPeer: (peer: Peer) => void,
): Promise<{ handle: ServerHandle; close: () => Promise<void> }> {
  const { default: http } = await import('node:http')
  const { WebSocketServer } = await import('ws')

  const hs = http.createServer()
  const wss = new WebSocketServer({
    server: hs, path: spec.opt.path, maxPayload: MAX_FRAME_SIZE, perMessageDeflate: false,
  })
  wss.on('connection', (ws: any) => onPeer(makeWsPeer(host, ws as WSLike, chunkSize, heartbeat)))
  await new Promise<void>((resolve, reject) => {
    hs.once('error', reject)
    hs.listen(spec.opt.port, spec.opt.ip, () => { hs.off('error', reject); resolve() })
  })
  const close = () => new Promise<void>((r) => { wss.close(() => hs.close(() => r())) })
  return { handle: { close }, close }
}
