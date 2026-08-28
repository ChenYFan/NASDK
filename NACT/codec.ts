/**
 * NACT codec — CBOR (cbor-x). The ONE place in the stack where objects become bytes.
 * CBOR over JSON: payloads carry raw Buffers (no base64 bloat). Over protobuf: schema-free
 * self-describing AND native binary at once (IETF RFC 8949, no codegen). MVP is fixed standard CBOR.
 */

import { encode as cborEncode, decode as cborDecode } from 'cbor-x'
import type { Codec } from './types.ts'
import type { NACPMessage } from '../NACP/types.ts'

/** The default codec; encodes envelope + payload in one pass, Buffers/TypedArrays as bytes. */
export const cborCodec: Codec = {
  encode: (msg) => cborEncode(msg),
  decode: (data) => cborDecode(data instanceof Uint8Array ? data : new Uint8Array(data)) as NACPMessage,
}
