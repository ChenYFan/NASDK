import type { Codec, NACPMessage, Peer } from './types.ts'

export interface PeerHost {
  codec: Codec
  deliver(msg: NACPMessage, peer: Peer): void
  fail(peer: Peer, reason: string): void
  gone(peer: Peer): void
  // Called last, after table insertion, so an immediate sendToPeer() finds the peer.
  arrived(peer: Peer): void
}
