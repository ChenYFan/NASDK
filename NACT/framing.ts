/**
 * NACT framing — fragmentation, reassembly, and the naked-stream parser. Pure functions, no NACT state.
 *
 * Every message carries a 24-byte fragment header: [msgId:16][offset:4][totalSize:4]. The sender splits when
 * 24+encoded exceeds chunkSize (otherwise one degenerate fragment, still headered — so the receiver has a
 * single uniform path). Fragments are self-describing, so the peer's own chunkSize is not our concern.
 *
 *   tcp/unix wire per fragment : [4B fragLen = 24+bodyLen][24B header][body]   (zero-copy send: 3 writes)
 *   ws wire per fragment       : one ws message = [24B header][body]           (send must concat: ws.send API)
 *
 * Copy discipline: the receive path performs exactly ONE copy — socket chunk straight into the
 * pre-allocated destination buffer at its offset. No Buffer.concat second pass.
 */

import { randomFillSync } from 'node:crypto'
import { nactInbound } from './errors.ts'

/** A NACPMessage is capped at 2GB by the upper layer; a fragment frame ≤ chunkSize ≤ 2GB. This guards a
 *  malicious/runaway length prefix from growing buffers unbounded (OOM) — it is not a physical limit. */
export const MAX_FRAME_SIZE = 2 * 1024 * 1024 * 1024   // 2 GiB
export const FRAG_HEADER = 24                          // [msgId:16][offset:4][totalSize:4]
export const REASSEMBLY_TIMEOUT_MS = 30000             // an in-flight msgId not completed in time → drop + error

/** Default LOCAL send-side chunk thresholds. unix effectively never splits (a ≤2GB message always fits one
 *  fragment); tcp/ws split at 100MB. Overridable per spec via TransportSpec.opt.chunkSize. */
export const DEFAULT_CHUNK: Record<string, number> = {
  unix: MAX_FRAME_SIZE,
  tcp: 100 * 1024 * 1024,
  ws: 100 * 1024 * 1024,
}

export function packFragHeader(msgId: Buffer, offset: number, totalSize: number): Buffer {
  const h = Buffer.allocUnsafe(FRAG_HEADER)
  msgId.copy(h, 0)
  h.writeUInt32BE(offset, 16)
  h.writeUInt32BE(totalSize, 20)
  return h
}

export function lenPrefix4(n: number): Buffer {
  const h = Buffer.allocUnsafe(4)
  h.writeUInt32BE(n, 0)
  return h
}

export interface Reassembler {
  /** Ensure the destination buffer for a msgId exists; returns it so the caller copies the body in place. */
  ensure(msgId: string, totalSize: number): Buffer
  /** Record [offset, offset+bodyLen) as filled. Completion fires onMsg; violations fire onError. */
  advance(msgId: string, offset: number, bodyLen: number): void
  clear(): void
}

/**
 * Single-copy reassembler: per msgId pre-allocate a totalSize buffer; each fragment's body is copied straight
 * into place at its offset — the one unavoidable socket-chunk→destination copy, with no concat afterwards.
 *
 * Completeness is guarded by a filled-interval set, because `received === total` ALONE cannot detect an
 * overlapping or duplicated fragment (a repeated offset would inflate the counter while leaving a hole). So
 * advance() bounds-checks and rejects overlap; with both enforced, received===total ⟺ the union covers
 * [0,total). Overlap means a buggy or hostile sender, so it drops the connection rather than guessing.
 */
export function makeReassembler(onMsg: (full: Buffer) => void, onError: (reason: string) => void): Reassembler {
  type Entry = { buf: Buffer; received: number; total: number; intervals: Array<[number, number]>; timer: ReturnType<typeof setTimeout> }
  const table = new Map<string, Entry>()
  return {
    ensure(msgId, totalSize) {
      let e = table.get(msgId)
      if (!e) {
        const timer = setTimeout(() => { table.delete(msgId); onError('reassembly-timeout') }, REASSEMBLY_TIMEOUT_MS)
        e = { buf: Buffer.allocUnsafe(totalSize), received: 0, total: totalSize, intervals: [], timer }
        table.set(msgId, e)
      }
      return e.buf
    },
    advance(msgId, offset, bodyLen) {
      const e = table.get(msgId)
      if (!e) return
      const lo = offset, hi = offset + bodyLen
      if (lo < 0 || bodyLen < 0 || hi > e.total) {
        clearTimeout(e.timer); table.delete(msgId); return onError('fragment-out-of-bounds')
      }
      for (const [s, t] of e.intervals) {
        if (lo < t && hi > s) { clearTimeout(e.timer); table.delete(msgId); return onError('overlapping-fragment') }
      }
      e.intervals.push([lo, hi])
      e.received += bodyLen
      if (e.received === e.total) { clearTimeout(e.timer); table.delete(msgId); onMsg(e.buf) }
    },
    clear() { for (const e of table.values()) clearTimeout(e.timer); table.clear() },
  }
}

/**
 * Fused stream parser for tcp/unix — a three-phase state machine over arriving socket chunks:
 *   [4B fragLen] → [24B header] (into a fixed small buffer) → body bytes copied STRAIGHT into the
 *   reassembler's pre-allocated destination at `offset` (hence "fused": no intermediate frame buffer).
 * Throws NACTError on an over-cap or undersized frame; the caller turns that into failPeer.
 */
export function makeStreamParser(reasm: Reassembler) {
  let phase: 'len' | 'header' | 'body' = 'len'
  const lenBuf = Buffer.allocUnsafe(4); let lenFilled = 0
  const hdrBuf = Buffer.allocUnsafe(FRAG_HEADER); let hdrFilled = 0
  let bodyLen = 0, bodyFilled = 0
  let dst: Buffer | null = null, dstOffset = 0, curMsgId = ''
  return (chunk: Buffer) => {
    let pos = 0
    while (pos < chunk.length) {
      if (phase === 'len') {
        const take = Math.min(4 - lenFilled, chunk.length - pos)
        chunk.copy(lenBuf, lenFilled, pos, pos + take); lenFilled += take; pos += take
        if (lenFilled < 4) return
        const fragLen = lenBuf.readUInt32BE(0)
        lenFilled = 0
        if (fragLen < FRAG_HEADER || fragLen > MAX_FRAME_SIZE)
          throw nactInbound('frame-too-large', `fragment length ${fragLen} out of range`)
        bodyLen = fragLen - FRAG_HEADER; phase = 'header'
      } else if (phase === 'header') {
        const take = Math.min(FRAG_HEADER - hdrFilled, chunk.length - pos)
        chunk.copy(hdrBuf, hdrFilled, pos, pos + take); hdrFilled += take; pos += take
        if (hdrFilled < FRAG_HEADER) return
        hdrFilled = 0
        curMsgId = hdrBuf.subarray(0, 16).toString('hex')
        dstOffset = hdrBuf.readUInt32BE(16)
        const totalSize = hdrBuf.readUInt32BE(20)
        dst = reasm.ensure(curMsgId, totalSize)
        bodyFilled = 0; phase = 'body'
        if (bodyLen === 0) { reasm.advance(curMsgId, dstOffset, 0); phase = 'len' }
      } else {
        // body — copy straight into the destination message buffer (the single copy)
        const take = Math.min(bodyLen - bodyFilled, chunk.length - pos)
        chunk.copy(dst!, dstOffset + bodyFilled, pos, pos + take); bodyFilled += take; pos += take
        if (bodyFilled === bodyLen) { reasm.advance(curMsgId, dstOffset, bodyLen); phase = 'len' }
      }
    }
  }
}

/** Split an encoded message into fragments, handing each to `emit(header, body)`. bodyMax = chunkSize-24.
 *  An empty message still emits one headered fragment, so the receive path has no special case. */
export function splitAndEmit(bytes: Buffer, chunkSize: number, emit: (header: Buffer, body: Buffer) => void) {
  const total = bytes.length
  const bodyMax = Math.max(1, chunkSize - FRAG_HEADER)
  const msgId = randomFillSync(Buffer.allocUnsafe(16))
  if (total === 0) { emit(packFragHeader(msgId, 0, 0), Buffer.alloc(0)); return }
  for (let off = 0; off < total; off += bodyMax) {
    const body = bytes.subarray(off, Math.min(off + bodyMax, total))   // zero-copy slice
    emit(packFragHeader(msgId, off, total), body)
  }
}
