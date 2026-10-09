// Per-peer state lives in the peer's closure; removal funnels through `gone`
// so row-drop and nact:peer:disconnect stay one event.

import type { NACTPeerId, Peer } from './types.ts'

export class PeerConnectionTable {
  private peerIdPeerSheet = new Map<NACTPeerId, Peer>()

  add(peer: Peer) { this.peerIdPeerSheet.set(peer.id, peer) }

  getPeerbyPeerId(peerId: NACTPeerId): Peer | undefined { return this.peerIdPeerSheet.get(peerId) }

  deletePeerbyPeerId(peerId: NACTPeerId): boolean { return this.peerIdPeerSheet.delete(peerId) }

  has(peerId: NACTPeerId): boolean { return this.peerIdPeerSheet.has(peerId) }
  listPeerId(): NACTPeerId[] { return [...this.peerIdPeerSheet.keys()] }
  listPeer(): Peer[] { return [...this.peerIdPeerSheet.values()] }

  clear() { this.peerIdPeerSheet.clear() }
  size(): number { return this.peerIdPeerSheet.size }
}
