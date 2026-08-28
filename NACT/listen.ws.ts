/**
 * NACT ws carrier — dial (browser global or Node ws) and listen (Node only).
 * listenWs reaches node:http + ws through a DYNAMIC import inside the function body, so a browser bundle
 * never resolves them.
 */

import type { PeerHost } from './peer.ts'
import type { Peer, ServerHandle, TransportSpec } from './types.ts'
import { makeWsPeer, type WSLike } from './peer.ws.ts'
import { MAX_FRAME_SIZE } from './framing.ts'

/** Dial a ws peer. Browsers use their global; Node versions without one load `ws` dynamically. */
export async function dialWs(
  host: PeerHost,
  spec: Extract<TransportSpec, { type: 'ws' }>,
  chunkSize: number,
  heartbeat: number | undefined,
): Promise<Peer> {
  const url = `ws://${spec.opt.ip}:${spec.opt.port}${spec.opt.path ?? ''}`
  const WebSocketImpl = globalThis.WebSocket ?? (await import('ws')).WebSocket
  const ws = new WebSocketImpl(url) as unknown as WSLike & {
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

/** Expose a ws entry. NODE ONLY — dynamic imports keep node:http/ws out of browser bundles.
 *  NACT owns its http server; a host that already terminated the upgrade hands its own Peer straight to
 *  NACP.inbound instead. */
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
