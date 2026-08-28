/**
 * NACT state — ONE table: PeerConnectionTable (peerId → peer). Per-peer state lives inside each peer's own
 * closure and dies with it. Every removal path funnels through the peer factories' `gone` callback, which
 * drops the row AND announces nact:peer:disconnect as one event.
 */

import type { NACTPeerId, Peer } from './types.ts'

// ── PeerConnectionTable ─────────────────────────────────────────────────────

export class PeerConnectionTable {
  private peerIdPeerSheet = new Map<NACTPeerId, Peer>()

  add(peer: Peer) { this.peerIdPeerSheet.set(peer.id, peer) }

  getPeerbyPeerId(peerId: NACTPeerId): Peer | undefined { return this.peerIdPeerSheet.get(peerId) }

  /** Whether a row was actually removed. */
  deletePeerbyPeerId(peerId: NACTPeerId): boolean { return this.peerIdPeerSheet.delete(peerId) }

  has(peerId: NACTPeerId): boolean { return this.peerIdPeerSheet.has(peerId) }
  listPeerId(): NACTPeerId[] { return [...this.peerIdPeerSheet.keys()] }
  listPeer(): Peer[] { return [...this.peerIdPeerSheet.values()] }

  clear() { this.peerIdPeerSheet.clear() }
  size(): number { return this.peerIdPeerSheet.size }
}
