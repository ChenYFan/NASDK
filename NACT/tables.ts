/**
 * NACT state — ONE table. Same shape as NACP/tables.ts: the table is an object with one `sheet` inside, not a
 * bare Map hanging off the layer, so the layer holds a named thing with a named surface rather than a
 * primitive it has to remember the rules for.
 *
 *   PeerConnectionTable — peerId → peer. NACT's ONLY state landing point.
 *
 * ── WHY ONLY ONE ──────────────────────────────────────────────────────────────────────────────────────
 * NACT flattens carriers; it does not model identity, protocol, or routing. appId↔peerId is NACP's
 * (PeerAppConnectionTable — note the different name for a different mapping), so the single thing NACT must
 * remember is "which live connections do I hold". Everything else it needs is per-peer state living INSIDE
 * the peer's own closure (framer buffer, reassembly table, heartbeat timer), which is why none of it is here:
 * that state dies with the peer, and a table would only give it a second lifetime to leak in.
 *
 * ── ONE WRITER FOR REMOVAL ────────────────────────────────────────────────────────────────────────────
 * Every exit path — graceful close, transport fault, remote hang-up — funnels through the peer factories'
 * `gone` callback, which is the one place that calls `drop()` and then announces nact:peer:disconnect. The
 * pair is deliberate: a row leaving the sheet and the announcement of that departure are the same event.
 * That is why `NACT.closePeer(peerId)` does NOT drop the row itself — doing so would manufacture a disconnect
 * nobody hears, and NACP learns to clear its appId and subscriptions only from that announcement.
 */

import type { NACTPeerId, Peer } from './types.ts'

// ── PeerConnectionTable ─────────────────────────────────────────────────────

export class PeerConnectionTable {
  /** The one sheet: peerId → peer. Keyed the way the hot path reads it — `sendToPeer` resolves a peerId to a
   *  connection on every outbound message. There is no reverse direction to serve: a Peer already carries
   *  its own `id`, so nothing ever needs to look a peerId up FROM a peer. */
  private peerIdPeerSheet = new Map<NACTPeerId, Peer>()

  add(peer: Peer) { this.peerIdPeerSheet.set(peer.id, peer) }

  getPeerbyPeerId(peerId: NACTPeerId): Peer | undefined { return this.peerIdPeerSheet.get(peerId) }

  /** Returns whether a row was actually removed, so a double-drop is visible rather than silent. */
  deletePeerbyPeerId(peerId: NACTPeerId): boolean { return this.peerIdPeerSheet.delete(peerId) }

  has(peerId: NACTPeerId): boolean { return this.peerIdPeerSheet.has(peerId) }
  listPeerId(): NACTPeerId[] { return [...this.peerIdPeerSheet.keys()] }
  /** Every live peer — used by terminate() to close them all. */
  listPeer(): Peer[] { return [...this.peerIdPeerSheet.values()] }

  clear() { this.peerIdPeerSheet.clear() }
  size(): number { return this.peerIdPeerSheet.size }
}
