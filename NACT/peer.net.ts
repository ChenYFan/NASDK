/**
 * NACT net peer factory — wraps a net.Socket (tcp/unix) into the uniform Peer abstraction. NODE-ONLY
 * (imports node:net; split from peer.ws.ts at the file level so bundlers never resolve it in a browser).
 * A naked stream has no message boundaries → length-carrying header + fused stream parser.
 */

import type net from 'node:net'
import { randomUUID } from 'node:crypto'
import type { NACPMessage, Peer } from './types.ts'
import type { PeerHost } from './peer.ts'
import { makeReassembler, makeStreamParser } from './framing.ts'
import { splitAndEmit } from './framing.ts'

/** Wrap a net.Socket (tcp/unix) into a Peer: chunked send (zero-copy, 2 writes) + fused single-copy receive. */
export function makeNetPeer(host: PeerHost, sock: net.Socket, chunkSize: number, heartbeatMs?: number): Peer {
  const peer: Peer = {
    id: randomUUID(),
    send: (msg) => {
      const enc = host.codec.encode(msg)
      splitAndEmit(enc, chunkSize, (header, body) => {
        // zero-copy: two writes, the body never concatenated
        sock.write(header)
        sock.write(body)
      })
    },
    close: () => sock.end(),
    terminate: () => sock.destroy(),
  }

  // Heartbeat = OS-level TCP keepalive; half-open connections surface as an ordinary 'close'.
  if (heartbeatMs) sock.setKeepAlive(true, heartbeatMs)

  const reasm = makeReassembler(
    (full) => {
      let msg: NACPMessage
      try { msg = host.codec.decode(full) } catch { return host.fail(peer, 'decode-failed') }
      host.deliver(msg, peer)
    },
    (reason) => host.fail(peer, reason),
  )
  const parse = makeStreamParser(reasm)

  sock.on('data', (chunk: Buffer) => {
    try { parse(chunk) } catch (e: any) { reasm.clear(); host.fail(peer, e?.code ?? 'framer-error') }
  })
  sock.on('close', () => { reasm.clear(); host.gone(peer) })
  sock.on('error', () => { /* 'close' always follows; disconnect is reported there */ })

  host.arrived(peer)
  return peer
}
