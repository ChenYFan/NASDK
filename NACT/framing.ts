/**
 * NACT framing — fragmentation, reassembly, and the naked-stream parser. Pure functions, no NACT state.
 *
 * Every message carries a 32-byte self-delimiting fragment header (thisFrameSize inside), so there is NO
 * outer length prefix on either carrier. Sender splits when 32+encoded exceeds chunkSize; an empty message
 * still emits one headered fragment. Receive path performs exactly ONE copy (chunk → destination at offset).
 * Byte type is `Uint8Array` (browser-safe); Node Buffer satisfies it as-is.
 */

import { nactInbound } from './errors.ts'

/** Uses global Web Crypto so this file stays browser-safe. */
function randomBytes16(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

/** OOM guard against malicious length prefixes, not a physical limit; also bounded by the runtime's max
 *  typed-array length (reassembly pre-allocates one Uint8Array(totalSize)). */
export const MAX_FRAME_SIZE = 2 * 1024 * 1024 * 1024   // 2 GiB

/**
 * Fragment header — 32 bytes, laid out on 2-byte alignment:
 *
 *   offset  size  field
 *   ------  ----  -------------
 *      0     16   msgId           random; shared by every fragment of one logical message
 *     16      4   offset          this fragment's start byte within the message
 *     20      4   totalSize       whole-message length (any-fragment-first pre-allocation)
 *     24      4   thisFrameSize   WHOLE fragment length INCLUDING this header; `< 32` = frame-too-small
 *     28      2   blank           RESERVED for future indicator/flag bits
 *     30      1   magic           0xCF in v1 — version-scoped, changes whenever the layout changes
 *     31      1   version         0x01 — last byte, always locatable without knowing the layout
 *
 * Parse order: version → magic → the rest (see checkFragHeader).
 */
export const FRAG_HEADER = 32
export const NACT_VERSION = 0x01                       // current wire-format version
/** Expected magic per wire version. */
export const MAGIC_BY_VERSION: Record<number, number> = { 0x01: 0xCF }

export const REASSEMBLY_TIMEOUT_MS = 30000             // in-flight msgId not completed in time → drop + error

/** Default LOCAL send-side chunk thresholds. Overridable via TransportSpec.opt.chunkSize. */
export const DEFAULT_CHUNK: Record<string, number> = {
  unix: MAX_FRAME_SIZE,
  tcp: 100 * 1024 * 1024,
  ws: 100 * 1024 * 1024,
}

/** Default heartbeat interval (ms). ON by default; `-1` disables. No separate timeout: the deadline IS the
 *  next interval, so worst-case detection is 2× this value. */
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
 * Version FIRST (its position is the only stable guarantee), then magic as corruption guard.
 * Unknown version → drop; no back-compat parsing.
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
 * Single-copy reassembler: per msgId pre-allocate a totalSize buffer; each fragment body copied straight
 * into place. Completeness guarded by a filled-interval set — `received === total` alone cannot detect an
 * overlapping/duplicated fragment; overlap means a buggy or hostile sender → drop.
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
 * Fused stream parser for tcp/unix — two-phase state machine over arriving socket chunks:
 * [32B header] → body bytes copied STRAIGHT into the reassembler's destination at `offset` (no intermediate
 * frame buffer). Throws NACTError on an over-cap/undersized frame or a rejected header.
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

/** Bytes → lowercase hex. Only used on the 16-byte msgId, not a hot path. */
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
