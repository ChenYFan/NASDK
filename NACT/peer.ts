/**
 * NACT peer factories — wrap a net.Socket (tcp/unix) or a ws WebSocket into the uniform Peer abstraction.
 *
 * Both carriers converge on the same shape: send = encode → split → write; receive = parse/deframe →
 * single-copy reassemble → decode → hand upward. The differences are entirely local to each factory
 * (naked stream needs a length prefix and a fused parser; ws already delivers message boundaries but its
 * send API forces one concat), which is exactly what makes the carriers interchangeable above this file.
 *
 * The factories take a PeerHost rather than the NACT instance: everything they need from NACT is four
 * callbacks, so they stay independently testable and cannot reach into NACT's other state.
 */

import type net from 'node:net'
import type { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type { Codec, NACPMessage, Peer } from './types.ts'
import {
  FRAG_HEADER, MAX_FRAME_SIZE, lenPrefix4, makeReassembler, makeStreamParser, splitAndEmit,
} from './framing.ts'

/** What a peer factory needs from its host (NACT). Deliberately four callbacks, not the NACT instance. */
export interface PeerHost {
  codec: Codec
  /** A decoded message is ready — hand it to the protocol layer (NACT's ref.inbound). */
  deliver(msg: NACPMessage, peer: Peer): void
  /** Transport-level fault → emit nact:peer:error, drop from the table, terminate. */
  fail(peer: Peer, reason: string): void
  /** The socket closed → drop from the table, emit nact:peer:disconnect. */
  gone(peer: Peer): void
  /** The peer is constructed AND registered in the table → emit nact:peer:connect.
   *  Called last, so a listener that immediately sendToPeer() finds the peer present (no gap). */
  arrived(peer: Peer): void
}

/** Wrap a net.Socket (tcp/unix) into a Peer: chunked send (zero-copy, 3 writes) + fused single-copy receive. */
export function makeNetPeer(host: PeerHost, sock: net.Socket, chunkSize: number): Peer {
  const peer: Peer = {
    id: randomUUID(),
    send: (msg) => {
      const enc = host.codec.encode(msg)
      const bytes = Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength)
      splitAndEmit(bytes, chunkSize, (header, body) => {
        // zero-copy send: three writes (length prefix + header + body subarray) — the body is never concatenated
        sock.write(lenPrefix4(FRAG_HEADER + body.length))
        sock.write(header)
        sock.write(body)
      })
    },
    close: () => sock.end(),
    terminate: () => sock.destroy(),
  }

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

/** Wrap a ws WebSocket into a Peer. One ws message = one fragment (boundaries come free); send must concat
 *  because ws.send takes a single contiguous buffer. */
export function makeWsPeer(host: PeerHost, ws: WebSocket, chunkSize: number): Peer {
  const peer: Peer = {
    id: randomUUID(),
    send: (msg) => {
      const enc = host.codec.encode(msg)
      const bytes = Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength)
      splitAndEmit(bytes, chunkSize, (header, body) => ws.send(Buffer.concat([header, body])))
    },
    close: () => ws.close(),
    terminate: () => ws.terminate(),
  }

  const reasm = makeReassembler(
    (full) => {
      let msg: NACPMessage
      try { msg = host.codec.decode(full) } catch { return host.fail(peer, 'decode-failed') }
      host.deliver(msg, peer)
    },
    (reason) => host.fail(peer, reason),
  )

  ws.on('message', (data: Buffer) => {
    const frag = data as Buffer
    if (frag.length < FRAG_HEADER) return host.fail(peer, 'frame-too-small')
    const msgId = frag.subarray(0, 16).toString('hex')
    const offset = frag.readUInt32BE(16)
    const totalSize = frag.readUInt32BE(20)
    if (totalSize > MAX_FRAME_SIZE) return host.fail(peer, 'frame-too-large')
    const body = frag.subarray(FRAG_HEADER)
    if (offset < 0 || offset + body.length > totalSize) return host.fail(peer, 'fragment-out-of-bounds')
    const dst = reasm.ensure(msgId, totalSize)
    body.copy(dst, offset)                        // single copy: ws message body → destination at offset
    reasm.advance(msgId, offset, body.length)     // asserts no overlap/duplicate; violation → host.fail
  })
  ws.on('close', () => { reasm.clear(); host.gone(peer) })
  ws.on('error', () => { /* 'close' always follows */ })

  host.arrived(peer)
  return peer
}
