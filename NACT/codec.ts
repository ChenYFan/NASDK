import { encode as cborEncode, decode as cborDecode } from 'cbor-x'
import type { Codec } from './types.ts'
import type { NACPMessage } from '../NACP/types.ts'

export const cborCodec: Codec = {
  encode: (msg) => cborEncode(msg),
  decode: (data) => cborDecode(data instanceof Uint8Array ? data : new Uint8Array(data)) as NACPMessage,
}
