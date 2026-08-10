/**
 * NACT ws peer factory — wraps a WebSocket into the uniform Peer abstraction.
 *
 * BROWSER-SAFE, and that is why it is split from `peer.net.ts`: this file has NO `node:*` import, so a browser
 * build can include it untouched. The seam is at the file level rather than a runtime branch because a bundler
 * resolves imports statically — an `if (isBrowser)` inside one factory would still drag `node:net` in.
 *
 * ONE code path serves both runtimes. It is written against the DOM WebSocket interface only:
 *
 *   addEventListener / binaryType / send / close    — standard in browsers, and the `ws` package implements
 *                                                     them too (it is not just an EventEmitter).
 *   .on() / .ping() / .terminate()                  — `ws`-only, deliberately NOT used here.
 *
 * The cost of that discipline is heartbeat: ping/pong are WebSocket CONTROL frames, and browser JS cannot send
 * or observe them at all. So this factory never pings. Half-open detection is the SERVER's job — a Node server
 * pings, and the browser's protocol stack answers pong on its own without JS involvement. `heartbeatMs` is
 * therefore accepted and ignored, keeping one signature across carriers.
 *
 * One ws message = one fragment (boundaries come free, so no stream parser); send must concat because
 * `send` takes a single contiguous buffer.
 */

import type { NACPMessage, Peer } from './types.ts'
import type { PeerHost } from './peer.ts'
import { FRAG_HEADER, MAX_FRAME_SIZE, checkFragHeader, makeReassembler, splitAndEmit, toHex } from './framing.ts'

/**
 * The slice of the DOM WebSocket interface this factory uses. Declared structurally rather than importing
 * `ws`'s class or relying on DOM lib types: the same shape has to describe a browser's native WebSocket and a
 * `ws` instance, and naming either one would tie a browser build to `ws` or a Node build to the DOM lib.
 */
export interface WSLike {
  binaryType: string
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', cb: (ev: { data: any }) => void): void
  addEventListener(type: 'close', cb: () => void): void
  addEventListener(type: 'error', cb: (ev: any) => void): void
}

/** Normalise whatever the runtime hands us into one Uint8Array view. Browsers give ArrayBuffer (we set
 *  binaryType), `ws` gives Buffer or ArrayBuffer depending on configuration, and a Buffer is already a
 *  Uint8Array — so the only real conversion is the ArrayBuffer case. Zero-copy in every branch. */
function asBytes(data: any): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null   // Blob (browser default binaryType) or a string frame — neither is a valid NACT fragment
}

export function makeWsPeer(host: PeerHost, ws: WSLike, chunkSize: number, _heartbeatMs?: number): Peer {
  // Must be set before any frame arrives: the browser default is 'blob', which would make every fragment
  // unreadable synchronously. 'arraybuffer' is understood by browsers and by `ws` alike.
  ws.binaryType = 'arraybuffer'

  const peer: Peer = {
    id: crypto.randomUUID(),
    send: (msg) => {
      const enc = host.codec.encode(msg)
      splitAndEmit(enc, chunkSize, (header, body) => {
        // ws.send takes ONE contiguous buffer, so this carrier pays a concat the net one avoids.
        const frame = new Uint8Array(header.length + body.length)
        frame.set(header, 0)
        frame.set(body, header.length)
        ws.send(frame)
      })
    },
    close: () => ws.close(),
    // No `terminate`: that is a `ws` extension with no browser equivalent. NACT's `fail` path falls back to
    // close() when terminate is absent, so a transport fault still brings the connection down.
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
    // ws has native frame boundaries, so thisFrameSize is redundant here — which makes it a free integrity
    // check: a mismatch means a buggy sender or a truncating middlebox, both of which must not be parsed on.
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
