/**
 * NACT peer contract — what a peer factory needs from NACT, and nothing else.
 * Factories live one per carrier (peer.net.ts Node-only / peer.ws.ts browser-safe) because their imports
 * differ in a way no runtime branch can paper over for a bundler.
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
