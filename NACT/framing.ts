import { nactInbound } from './errors.ts'

// Global Web Crypto: keeps this file browser-safe.
function randomBytes16(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

// OOM guard against hostile length prefixes, not a physical limit.
export const MAX_FRAME_SIZE = 2 * 1024 * 1024 * 1024

/**
 * Frame header — 32 bytes, 2-byte aligned:
 *   0  +16  msgId         random; shared by every frame of one packet
 *  16   4  offset         this frame's start within the packet
 *  20   4  totalSize      whole-packet length
 *  24   4  thisFrameSize  whole frame length INCLUDING header
 *  28   2  reserved       for future indicator/flag bits
 *  30   1  magic          version-scoped; changes when layout changes
 *  31   1  version        last byte — locatable without knowing the layout
 */
export const FRAME_HEADER_SIZE = 32
export const NACT_VERSION = 0x01
export const MAGIC_BY_VERSION: Record<number, number> = { 0x01: 0xCF }

export const REASSEMBLY_TIMEOUT_MS = 30000             // incomplete msgId → drop + error

// Legacy; Providers own runtime defaults.
export const DEFAULT_CHUNK: Record<string, number> = {
  unix: MAX_FRAME_SIZE,
  tcp: 100 * 1024 * 1024,
  websocket: 100 * 1024 * 1024,
}

export function packFrameHeader(msgId: Uint8Array, offset: number, totalSize: number, bodyLen: number): Uint8Array {
  const h = new Uint8Array(FRAME_HEADER_SIZE)
  h.set(msgId.subarray(0, 16), 0)
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  dv.setUint32(16, offset)
  dv.setUint32(20, totalSize)
  dv.setUint32(24, FRAME_HEADER_SIZE + bodyLen)
  dv.setUint16(28, 0)
  dv.setUint8(30, MAGIC_BY_VERSION[NACT_VERSION]!)
  dv.setUint8(31, NACT_VERSION)
  return h
}

// Version first (its position is the only stable guarantee); unknown version → drop, no back-compat.
export function checkFrameHeader(h: Uint8Array): 'version-mismatch' | 'bad-magic' | null {
  const version = h[31]!
  const expectMagic = MAGIC_BY_VERSION[version]
  if (expectMagic === undefined) return 'version-mismatch'
  if (h[30] !== expectMagic) return 'bad-magic'
  return null
}

export interface Reassembler {
  ensure(msgId: string, totalSize: number): Uint8Array
  advance(msgId: string, offset: number, bodyLen: number): void
  has(msgId: string): boolean
  clear(): void
}

// The filled-interval set is what detects overlaps; `received === total` alone cannot.
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
        clearTimeout(e.timer); table.delete(msgId); return onError('frame-out-of-bounds')
      }
      for (const [s, t] of e.intervals) {
        if (lo < t && hi > s) { clearTimeout(e.timer); table.delete(msgId); return onError('overlapping-frame') }
      }
      e.intervals.push([lo, hi])
      e.received += bodyLen
      if (e.received === e.total) { clearTimeout(e.timer); table.delete(msgId); onMsg(e.buf) }
    },
    has: msgId => table.has(msgId),
    clear() { for (const e of table.values()) clearTimeout(e.timer); table.clear() },
  }
}

export interface FrameReceiver {
  receive(frame: readonly Uint8Array[]): void
  clear(): void
}

function copyFrom(frame: readonly Uint8Array[], from: number, length: number, dst: Uint8Array, at: number) {
  for (const bytes of frame) {
    if (!length) return
    if (from >= bytes.byteLength) { from -= bytes.byteLength; continue }
    const part = bytes.subarray(from, from + length)
    dst.set(part, at)
    at += part.byteLength
    length -= part.byteLength
    from = 0
  }
}

export function makeFrameReceiver(onMsg: (full: Uint8Array) => void, onError: (reason: string) => void): FrameReceiver {
  const reasm = makeReassembler(onMsg, onError)
  const header = new Uint8Array(FRAME_HEADER_SIZE)
  const view = new DataView(header.buffer)
  return {
    receive(frame) {
      let size = 0
      for (const bytes of frame) size += bytes.byteLength
      if (size < FRAME_HEADER_SIZE) throw nactInbound('frame-too-small', `frame size ${size} below header size ${FRAME_HEADER_SIZE}`)
      copyFrom(frame, 0, FRAME_HEADER_SIZE, header, 0)
      const bad = checkFrameHeader(header)
      if (bad) throw nactInbound(bad, `frame header rejected: ${bad}`)
      const frameSize = view.getUint32(24)
      if (frameSize > MAX_FRAME_SIZE)
        throw nactInbound('frame-too-large', `frame size ${frameSize} exceeds cap ${MAX_FRAME_SIZE}`)
      if (frameSize !== size)
        throw nactInbound('frame-size-mismatch', `header says ${frameSize} bytes, frame has ${size}`)

      const msgId = toHex(header.subarray(0, 16))
      const offset = view.getUint32(16)
      const total = view.getUint32(20)
      const bodyLen = size - FRAME_HEADER_SIZE
      if (offset === 0 && bodyLen === total && !reasm.has(msgId)) {
        const first = frame[0]!
        if (first.byteLength >= size) return onMsg(first.subarray(FRAME_HEADER_SIZE, size))
        if (first.byteLength === FRAME_HEADER_SIZE && frame.length === 2) return onMsg(frame[1]!)
        const body = new Uint8Array(bodyLen)
        copyFrom(frame, FRAME_HEADER_SIZE, bodyLen, body, 0)
        return onMsg(body)
      }

      const dst = reasm.ensure(msgId, total)
      if (offset + bodyLen <= dst.byteLength) copyFrom(frame, FRAME_HEADER_SIZE, bodyLen, dst, offset)
      reasm.advance(msgId, offset, bodyLen)
    },
    clear: () => reasm.clear(),
  }
}

export function toHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0')
  return s
}

// An empty packet still emits one frame: no special case on the receive path.
export function splitAndEmit(bytes: Uint8Array, chunkSize: number, emit: (header: Uint8Array, body: Uint8Array) => void) {
  const total = bytes.length
  const bodyMax = Math.max(1, chunkSize - FRAME_HEADER_SIZE)
  const msgId = randomBytes16()
  if (total === 0) { emit(packFrameHeader(msgId, 0, 0, 0), new Uint8Array(0)); return }
  for (let off = 0; off < total; off += bodyMax) {
    const body = bytes.subarray(off, Math.min(off + bodyMax, total))
    emit(packFrameHeader(msgId, off, total, body.length), body)
  }
}
