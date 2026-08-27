/**
 * NACT codec — CBOR (cbor-x). This is the ONE place in the stack where objects become bytes.
 *
 * Why CBOR and not JSON: payloads carry raw Buffers (images, embeddings, audio). JSON forces base64 — 33%
 * bloat plus encode/decode CPU. CBOR's byte-string type takes them as bytes, no base64, so large binary
 * rides the standard channel with no shm sideband.
 *
 * Why CBOR and not protobuf: NACP needs "schema-free self-describing" AND "native binary that the encoder
 * can walk" at the same time. protobuf gives one or the other (bytes is an opaque blob; Struct/Value has no
 * bytes variant; Any needs the peer to hold the schema). CBOR's map — string keys, byte-string values —
 * satisfies both in one message, is IETF RFC 8949, needs no codegen, and has the widest cross-language
 * reach (a bet on NACP eventually leaving the JS boundary: tcp carriers, non-JS Apps, the C++/FFI edge).
 *
 * MVP is fixed standard CBOR: useRecords is left off, and no record-extension negotiation happens
 * (TransportSpec.opt.compression is a reserved slot NACT does not read).
 */

import { encode as cborEncode, decode as cborDecode } from 'cbor-x'
import type { Codec } from './types.ts'
import type { NACPMessage } from '../NACP/types.ts'

/** The default codec. The whole message (envelope + payload) is encoded in one pass; the encoder walks the
 *  structure and drops Buffers/TypedArrays in as bytes — never understanding what the payload MEANS. That is
 *  what "semantically opaque, physically traversable" means, and it needs no separate widened view of the
 *  envelope: cbor-x takes `any`, so a NACPMessage goes in as it stands. */
export const cborCodec: Codec = {
  encode: (msg) => cborEncode(msg),
  decode: (data) => cborDecode(data instanceof Uint8Array ? data : new Uint8Array(data)) as NACPMessage,
}
