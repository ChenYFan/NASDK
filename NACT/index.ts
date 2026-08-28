/**
 * NACT public API barrel: the transport face, the default codec, transport-layer shapes, physical-lifecycle
 * events, and the layer error.
 */

export { NACT } from './NACT.ts'
export { cborCodec } from './codec.ts'

export type {
  Transport, TransportSpec, WSOpt, TCPOpt, UnixOpt, ServerOptBase, HeartbeatMs, CompressionKind,
  NACTPeerId, Peer, Codec, ServerHandle,
} from './types.ts'

export { NACTEvent } from './events.ts'
export type { PeerPayload, PeerErrorPayload, PeerErrorReason } from './events.ts'

export { NACTError, nactInbound, nactInternal, nactOutbound } from './errors.ts'
