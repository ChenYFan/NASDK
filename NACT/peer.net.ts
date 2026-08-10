/**
 * NACT net peer factory — wraps a net.Socket (tcp/unix) into the uniform Peer abstraction.
 *
 * NODE-ONLY, and that is the reason this file exists apart from `peer.ws.ts`: it imports `node:net`, which no
 * browser can provide (there is no raw-socket API). A browser build must never reach this module, so the split
 * is by CARRIER at the file level rather than by a runtime branch inside one factory — an `if` would still
 * leave the `node:net` import for a bundler to resolve.
 *
 * A naked stream has no message boundaries, so this carrier needs the length-carrying header plus the fused
 * stream parser. `peer.ws.ts` gets boundaries free from the ws protocol and therefore looks different — those
 * differences are entirely local to each factory, which is what keeps the carriers interchangeable above here.
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
        // zero-copy send: two writes (self-delimiting header + body subarray) — the body is never concatenated
        sock.write(header)
        sock.write(body)
      })
    },
    close: () => sock.end(),
    terminate: () => sock.destroy(),
  }

  // Heartbeat for tcp/unix: hand it to OS-level TCP keepalive. The OS runs its own probe/retry schedule, so
  // the interval is all it takes; half-open connections surface as an ordinary 'close'.
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
