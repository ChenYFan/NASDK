/**
 * NACT net carrier — listen + dial for tcp and unix.
 *
 * NODE-ONLY: `node:net` has no browser equivalent (there is no raw-socket API), so this module is one of the
 * two that a browser build must never import. Its counterpart is `listen.ws.ts`, which is browser-safe.
 *
 * These functions do not touch NACT's tables — the peer factory does that through PeerHost. What lives here is
 * only "how does this carrier produce a socket": bind an address and accept, or connect out.
 */

import net from 'node:net'
import type { PeerHost } from './peer.ts'
import type { Peer, ServerHandle, TransportSpec } from './types.ts'
import { makeNetPeer } from './peer.net.ts'

/** The address argument shape differs per carrier, so it is resolved once here rather than at both call sites. */
function addrOf(spec: Extract<TransportSpec, { type: 'unix' | 'tcp' }>): any {
  return spec.type === 'unix' ? spec.opt.socketPath : { port: spec.opt.port, host: spec.opt.ip }
}

/** Expose a tcp/unix entry. Each accepted connection mints a Peer (already table-registered by the factory)
 *  and is handed to onPeer — the handshake itself is the caller's business, not this layer's. */
export async function listenNet(
  host: PeerHost,
  spec: Extract<TransportSpec, { type: 'unix' | 'tcp' }>,
  chunkSize: number,
  heartbeat: number | undefined,
  onPeer: (peer: Peer) => void,
): Promise<{ handle: ServerHandle; server: net.Server }> {
  const server = net.createServer((sock) => onPeer(makeNetPeer(host, sock, chunkSize, heartbeat)))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(addrOf(spec), () => { server.off('error', reject); resolve() })
  })
  return { handle: { close: () => new Promise<void>((r) => server.close(() => r())) }, server }
}

/** Dial a tcp/unix peer. The Peer is minted (and table-registered) for this one connection; the register
 *  handshake is the caller's (NApp.connect's) business. */
export async function dialNet(
  host: PeerHost,
  spec: Extract<TransportSpec, { type: 'unix' | 'tcp' }>,
  chunkSize: number,
  heartbeat: number | undefined,
): Promise<Peer> {
  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s = net.createConnection(addrOf(spec))
    s.once('connect', () => { s.off('error', reject); resolve(s) })
    s.once('error', reject)
  })
  return makeNetPeer(host, sock, chunkSize, heartbeat)
}
