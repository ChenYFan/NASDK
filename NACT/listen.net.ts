/**
 * NACT net carrier — listen + dial for tcp and unix. NODE-ONLY (no browser raw-socket API).
 * Only "how does this carrier produce a socket"; tables are the peer factory's business via PeerHost.
 */

import net from 'node:net'
import type { PeerHost } from './peer.ts'
import type { Peer, ServerHandle, TransportSpec } from './types.ts'
import { makeNetPeer } from './peer.net.ts'

function addrOf(spec: Extract<TransportSpec, { type: 'unix' | 'tcp' }>): any {
  return spec.type === 'unix' ? spec.opt.socketPath : { port: spec.opt.port, host: spec.opt.ip }
}

/** Expose a tcp/unix entry; each accepted connection mints a Peer handed to onPeer. */
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

/** Dial a tcp/unix peer. */
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
