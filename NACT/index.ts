/**
 * NACT public API barrel.
 *
 * Exposes the transport face (NACT), the default codec, the transport-layer shapes consumers name in their
 * own signatures (TransportSpec and friends, Peer, NACTPeerId), and the layer error. Internal machinery —
 * the peer factories, the framing/reassembly functions, the PeerHost contract, the peer table — is
 * intentionally not re-exported: they are how NACT works, not what it offers.
 */

export { NACT } from './NACT.ts'
export { cborCodec } from './codec.ts'

export type {
  // carrier + address
  Transport, TransportSpec, WSOpt, TCPOpt, UnixOpt, ServerOptBase, HeartbeatMs, CompressionKind,
  // the uniform physical-connection abstraction
  NACTPeerId, Peer, Codec, ServerHandle,
  // the wire view of a NACP message (payload widened unknown → any, for the encoder only)
  NACPWireMessage,
} from './types.ts'

// physical-lifecycle event names + payloads (observation surface)
export { NACTEvent } from './events.ts'
export type { PeerPayload, PeerErrorPayload, PeerErrorReason } from './events.ts'

export { NACTError, nactInbound, nactInternal, nactOutbound } from './errors.ts'
