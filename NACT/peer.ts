/**
 * NACT peer contract — what the TransportChannel adapter needs from NACT, and nothing else.
 */

import type { Codec, NACPMessage, Peer } from './types.ts'

/** What a peer factory needs from its host (NACT) — four callbacks, not the NACT instance. */
export interface PeerHost {
  codec: Codec
  deliver(msg: NACPMessage, peer: Peer): void
  fail(peer: Peer, reason: string): void
  gone(peer: Peer): void
  /** Called last, after table registration, so an immediate sendToPeer() finds the peer present. */
  arrived(peer: Peer): void
}
