/**
 * NACT framing — fragmentation, reassembly, and the naked-stream parser. Pure functions, no NACT state.
 *
 * Every message carries a 32-byte fragment header (see FRAG_HEADER layout below). The sender splits when
 * 32+encoded exceeds chunkSize (otherwise one degenerate fragment, still headered — so the receiver has a
 * single uniform path). Fragments are self-describing, so the peer's own chunkSize is not our concern.
 *
 * The header carries its own length (thisFrameSize), so there is NO outer length prefix on either carrier:
 *
 *   tcp/unix wire per fragment : [32B header][body]                (zero-copy send: 2 writes)
 *   ws wire per fragment       : one ws message = [32B header][body]  (send must concat: ws.send API)
 *
 * Copy discipline: the receive path performs exactly ONE copy — socket chunk straight into the
 * pre-allocated destination buffer at its offset. No concat second pass.
 *
 * Byte type is `Uint8Array`, never `Buffer`: this file is carrier-agnostic and must run in a browser build,
 * where `Buffer` does not exist. Node's Buffer IS a Uint8Array subclass, so a socket chunk satisfies these
 * signatures as-is — the reverse would not hold, which is why the base type is the one written here.
 */

import { nactInbound } from './errors.ts'

/** 16 random bytes for a msgId. Uses the GLOBAL Web Crypto (`crypto.getRandomValues`) rather than
 *  `node:crypto`'s randomFillSync — globalThis.crypto is standard in browsers and in Node ≥19, so this file
 *  carries no Node-only import and runs unchanged in a browser build. */
function randomBytes16(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

/** A NACPMessage is capped at 2GB by the upper layer; a fragment frame ≤ chunkSize ≤ 2GB. This guards a
 *  malicious/runaway length prefix from growing buffers unbounded (OOM) — it is not a physical limit.
 *
 *  The real ceiling above this is NOT the header width but the runtime's max typed-array length: reassembly
 *  pre-allocates one `new Uint8Array(totalSize)`, and CBOR encodes into one contiguous buffer. Widening
 *  totalSize alone buys nothing — passing 4GiB requires the reassembled message to stop being a single
 *  allocation. */
export const MAX_FRAME_SIZE = 2 * 1024 * 1024 * 1024   // 2 GiB

/**
 * Fragment header — 32 bytes, laid out on 2-byte alignment. It is SELF-DELIMITING: thisFrameSize lives
 * inside the header, so tcp/unix needs no outer length prefix (the header is fixed-length, so the parser
 * can always read all 32 bytes before it needs to know how long the body is).
 *
 *   offset  size  field           v1 value
 *   ------  ----  -------------   ----------------------------------------------------------------
 *      0     16   msgId           random; shared by every fragment of one logical message
 *     16      4   offset          this fragment's start byte within the message
 *     20      4   totalSize       whole-message length (redundant per fragment: any-fragment-first
 *                                 pre-allocation + out-of-order tolerance)
 *     24      4   thisFrameSize   WHOLE fragment length INCLUDING this 32B header, so
 *                                 bodyLen = thisFrameSize - 32. Replaces the old outer 4B length
 *                                 prefix; `< 32` is an inherent frame-too-small sentinel.
 *     28      2   blank           RESERVED for future indicator/flag bits (e.g. codec, compression)
 *     30      1   magic           0xCF in v1. VERSION-SCOPED: it changes whenever the layout changes,
 *                                 so it is not a protocol-wide fingerprint — read version first.
 *     31      1   version         0x01. The LAST byte of the header, deliberately: a receiver can always
 *                                 locate the version without knowing anything else about the layout.
 *
 * Parse order is therefore version → magic → the rest. See checkFragHeader().
 */
export const FRAG_HEADER = 32
export const NACT_VERSION = 0x01                       // current wire-format version
/** Expected magic per wire version. Magic is version-scoped by design, so this is a table, not a constant. */
export const MAGIC_BY_VERSION: Record<number, number> = { 0x01: 0xCF }

export const REASSEMBLY_TIMEOUT_MS = 30000             // an in-flight msgId not completed in time → drop + error

/** Default LOCAL send-side chunk thresholds. unix effectively never splits (a ≤2GB message always fits one
 *  fragment); tcp/ws split at 100MB. Overridable per spec via TransportSpec.opt.chunkSize. */
export const DEFAULT_CHUNK: Record<string, number> = {
  unix: MAX_FRAME_SIZE,
  tcp: 100 * 1024 * 1024,
  ws: 100 * 1024 * 1024,
}

/** Default heartbeat interval, in ms. ON by default — a silently half-open connection is worse than a
 *  spurious drop, and nothing above NACT can detect one. Override per spec via TransportSpec.opt.heartbeat;
 *  `-1` disables it entirely.
 *
 *  There is no separate timeout: the deadline IS the next interval. A ping goes out, and if the pong has not
 *  come back by the time the next ping is due, the connection is declared dead. So the worst-case detection
 *  time is 2× this value (30s to notice, 30s to confirm = 60s). */
export const DEFAULT_HEARTBEAT_MS = 30_000

export function packFragHeader(msgId: Uint8Array, offset: number, totalSize: number, bodyLen: number): Uint8Array {
  const h = new Uint8Array(FRAG_HEADER)
  h.set(msgId.subarray(0, 16), 0)
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  dv.setUint32(16, offset)
  dv.setUint32(20, totalSize)
  dv.setUint32(24, FRAG_HEADER + bodyLen)                  // thisFrameSize: header + body
  dv.setUint16(28, 0)                                      // blank — reserved for indicator bits
  dv.setUint8(30, MAGIC_BY_VERSION[NACT_VERSION]!)
  dv.setUint8(31, NACT_VERSION)
  return h
}

/**
 * Validate the version/magic pair of a received 32B header. Returns a failure reason, or null if acceptable.
 *
 * Version FIRST, then magic: magic is version-scoped (it changes with the layout), so the version field is
 * the only thing whose position is guaranteed stable across versions — hence its home at the tail of the
 * header. Once the version is known, the magic expected for THAT version is checked as a corruption guard.
 *
 * Unknown version → drop. NACT is pure infrastructure with no back-compat parsing: two mismatched builds in
 * one deployment is an operational fault, and degrading silently would only bury it deeper.
 */
export function checkFragHeader(h: Uint8Array): 'version-mismatch' | 'bad-magic' | null {
  const version = h[31]!
  const expectMagic = MAGIC_BY_VERSION[version]
  if (expectMagic === undefined) return 'version-mismatch'
  if (h[30] !== expectMagic) return 'bad-magic'
  return null
}

export interface Reassembler {
  /** Ensure the destination buffer for a msgId exists; returns it so the caller copies the body in place. */
  ensure(msgId: string, totalSize: number): Uint8Array
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
export function makeReassembler(onMsg: (full: Uint8Array) => void, onError: (reason: string) => void): Reassembler {
  type Entry = { buf: Uint8Array; received: number; total: number; intervals: Array<[number, number]>; timer: ReturnType<typeof setTimeout> }
  const table = new Map<string, Entry>()
  return {
    ensure(msgId, totalSize) {
      let e = table.get(msgId)
      if (!e) {
        const timer = setTimeout(() => { table.delete(msgId); onError('reassembly-timeout') }, REASSEMBLY_TIMEOUT_MS)
        e = { buf: new Uint8Array(totalSize), received: 0, total: totalSize, intervals: [], timer }
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
 * Fused stream parser for tcp/unix — a two-phase state machine over arriving socket chunks:
 *   [32B header] (into a fixed small buffer) → body bytes copied STRAIGHT into the reassembler's
 *   pre-allocated destination at `offset` (hence "fused": no intermediate frame buffer).
 *
 * There is no outer length prefix: the header is fixed-length and self-delimiting, so the parser reads all
 * 32 bytes unconditionally and takes bodyLen from thisFrameSize.
 * Throws NACTError on an over-cap/undersized frame or a rejected header; the caller turns that into failPeer.
 */
export function makeStreamParser(reasm: Reassembler) {
  let phase: 'header' | 'body' = 'header'
  const hdrBuf = new Uint8Array(FRAG_HEADER); let hdrFilled = 0
  const hdrView = new DataView(hdrBuf.buffer, hdrBuf.byteOffset, hdrBuf.byteLength)
  let bodyLen = 0, bodyFilled = 0
  let dst: Uint8Array | null = null, dstOffset = 0, curMsgId = ''
  return (chunk: Uint8Array) => {
    let pos = 0
    while (pos < chunk.length) {
      if (phase === 'header') {
        const take = Math.min(FRAG_HEADER - hdrFilled, chunk.length - pos)
        hdrBuf.set(chunk.subarray(pos, pos + take), hdrFilled); hdrFilled += take; pos += take
        if (hdrFilled < FRAG_HEADER) return
        hdrFilled = 0
        const bad = checkFragHeader(hdrBuf)
        if (bad) throw nactInbound(bad, `fragment header rejected: ${bad}`)
        const frameSize = hdrView.getUint32(24)
        if (frameSize < FRAG_HEADER)
          throw nactInbound('frame-too-small', `frame size ${frameSize} below header size ${FRAG_HEADER}`)
        if (frameSize > MAX_FRAME_SIZE)
          throw nactInbound('frame-too-large', `frame size ${frameSize} exceeds cap ${MAX_FRAME_SIZE}`)
        bodyLen = frameSize - FRAG_HEADER
        curMsgId = toHex(hdrBuf.subarray(0, 16))
        dstOffset = hdrView.getUint32(16)
        const totalSize = hdrView.getUint32(20)
        dst = reasm.ensure(curMsgId, totalSize)
        bodyFilled = 0; phase = 'body'
        if (bodyLen === 0) { reasm.advance(curMsgId, dstOffset, 0); phase = 'header' }
      } else {
        // body — copy straight into the destination message buffer (the single copy)
        const take = Math.min(bodyLen - bodyFilled, chunk.length - pos)
        dst!.set(chunk.subarray(pos, pos + take), dstOffset + bodyFilled); bodyFilled += take; pos += take
        if (bodyFilled === bodyLen) { reasm.advance(curMsgId, dstOffset, bodyLen); phase = 'header' }
      }
    }
  }
}

/** Bytes → lowercase hex. Replaces `Buffer.toString('hex')`, which Uint8Array does not have. Used ONLY on the
 *  16-byte msgId, so the per-byte loop is not on a hot path. */
export function toHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0')
  return s
}

/** Split an encoded message into fragments, handing each to `emit(header, body)`. bodyMax = chunkSize-32.
 *  An empty message still emits one headered fragment, so the receive path has no special case. */
export function splitAndEmit(bytes: Uint8Array, chunkSize: number, emit: (header: Uint8Array, body: Uint8Array) => void) {
  const total = bytes.length
  const bodyMax = Math.max(1, chunkSize - FRAG_HEADER)
  const msgId = randomBytes16()
  if (total === 0) { emit(packFragHeader(msgId, 0, 0, 0), new Uint8Array(0)); return }
  for (let off = 0; off < total; off += bodyMax) {
    const body = bytes.subarray(off, Math.min(off + bodyMax, total))   // zero-copy slice
    emit(packFragHeader(msgId, off, total, body.length), body)
  }
}
