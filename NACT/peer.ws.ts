/**
 * NACT ws peer factory — wraps a WebSocket into the uniform Peer abstraction. BROWSER-SAFE (no node:* import;
 * split from peer.net.ts at the file level so bundlers never resolve node:net).
 *
 * Written against the DOM WebSocket interface only (.on/.ping/.terminate are `ws`-only and unused).
 * Cost: no heartbeat — browser JS cannot send/observe ping control frames; half-open detection is the
 * SERVER's job. `heartbeatMs` accepted and ignored. One ws message = one fragment; send must concat.
 */

import type { NACPMessage, Peer } from './types.ts'
import type { PeerHost } from './peer.ts'
import { FRAG_HEADER, MAX_FRAME_SIZE, checkFragHeader, makeReassembler, splitAndEmit, toHex } from './framing.ts'

/** The slice of the DOM WebSocket interface this factory uses, declared structurally. */
export interface WSLike {
  binaryType: string
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', cb: (ev: { data: any }) => void): void
  addEventListener(type: 'close', cb: () => void): void
  addEventListener(type: 'error', cb: (ev: any) => void): void
}

/** Normalise the runtime's frame into one Uint8Array view (zero-copy in every branch). */
function asBytes(data: any): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null   // Blob or string frame — not a valid NACT fragment
}

export function makeWsPeer(host: PeerHost, ws: WSLike, chunkSize: number, _heartbeatMs?: number): Peer {
  // Before any frame arrives: browser default 'blob' would make fragments unreadable synchronously.
  ws.binaryType = 'arraybuffer'

  const peer: Peer = {
    id: crypto.randomUUID(),
    send: (msg) => {
      const enc = host.codec.encode(msg)
      splitAndEmit(enc, chunkSize, (header, body) => {
        // ws.send takes ONE contiguous buffer → concat.
        const frame = new Uint8Array(header.length + body.length)
        frame.set(header, 0)
        frame.set(body, header.length)
        ws.send(frame)
      })
    },
    close: () => ws.close(),
    // No terminate: NACT's fail path falls back to close() when absent.
  }

  const reasm = makeReassembler(
    (full) => {
      let msg: NACPMessage
      try { msg = host.codec.decode(full) } catch { return host.fail(peer, 'decode-failed') }
      host.deliver(msg, peer)
    },
    (reason) => host.fail(peer, reason),
  )

  ws.addEventListener('message', (ev) => {
    const frag = asBytes(ev.data)
    if (!frag) return host.fail(peer, 'non-binary-frame')
    if (frag.length < FRAG_HEADER) return host.fail(peer, 'frame-too-small')
    const bad = checkFragHeader(frag)
    if (bad) return host.fail(peer, bad)
    const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength)
    const msgId = toHex(frag.subarray(0, 16))
    const offset = dv.getUint32(16)
    const totalSize = dv.getUint32(20)
    if (totalSize > MAX_FRAME_SIZE) return host.fail(peer, 'frame-too-large')
    const body = frag.subarray(FRAG_HEADER)
    // Native boundaries make this a free integrity check against buggy senders / truncating middleboxes.
    if (dv.getUint32(24) !== frag.length) return host.fail(peer, 'frame-size-mismatch')
    if (offset < 0 || offset + body.length > totalSize) return host.fail(peer, 'fragment-out-of-bounds')
    const dst = reasm.ensure(msgId, totalSize)
    dst.set(body, offset)                         // single copy: ws message body → destination at offset
    reasm.advance(msgId, offset, body.length)     // asserts no overlap/duplicate; violation → host.fail
  })
  ws.addEventListener('close', () => { reasm.clear(); host.gone(peer) })
  ws.addEventListener('error', () => { /* 'close' always follows */ })

  host.arrived(peer)
  return peer
}
