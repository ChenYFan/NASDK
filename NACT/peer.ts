/**
 * NACT peer contract — what a peer factory needs from NACT, and nothing else.
 *
 * The factories themselves live one per carrier, because their IMPORTS differ in a way no runtime branch can
 * paper over:
 *
 *   peer.net.ts  imports `node:net`         → Node only
 *   peer.ws.ts   imports nothing Node-only  → browser and Node
 *
 * A bundler resolves imports statically, so keeping both in one file would drag `node:net` into a browser
 * build no matter what guards surrounded the call. Hence the split; this file holds the seam they share.
 *
 * Both carriers converge on the same Peer shape: send = encode → split → write; receive = deframe →
 * single-copy reassemble → decode → hand upward. The differences (a naked stream needs a length-carrying
 * header and a fused parser; ws already has message boundaries but its send API forces one concat) stay
 * local to each factory, which is what makes the carriers interchangeable above this layer.
 */

import type { Codec, NACPMessage, Peer } from './types.ts'

/** What a peer factory needs from its host (NACT). Deliberately four callbacks, not the NACT instance —
 *  so the factories stay independently testable and cannot reach into NACT's other state. */
export interface PeerHost {
  codec: Codec
  /** A decoded message is ready — hand it to the protocol layer (NACT implements this as napp.nacp.inbound). */
  deliver(msg: NACPMessage, peer: Peer): void
  /** Transport-level fault → emit nact:peer:error, drop from the table, terminate. */
  fail(peer: Peer, reason: string): void
  /** The socket closed → drop from the table, emit nact:peer:disconnect. */
  gone(peer: Peer): void
  /** The peer is constructed AND registered in the table → emit nact:peer:connect.
   *  Called last, so a listener that immediately sendToPeer() finds the peer present (no gap). */
  arrived(peer: Peer): void
}
