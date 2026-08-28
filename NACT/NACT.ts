/**
 * NACT — the transport face: flattens ws/tcp/unix into a uniform Peer abstraction ({id, send, close}).
 * Never touches appId, protocol semantics, payload meaning, auth or routing. Browser-safe: carrier code
 * needing node:* lives behind listen.net.ts / listen.ws.ts (dynamic import); browser gets ws-client only,
 * everything else fails loudly (browser-no-server / browser-no-carrier).
 */

import type { NACPMessage } from '../NACP/types.ts'
import type { NApp } from '../NApp/NApp.ts'
import type { Codec, NACTPeerId, Peer, ServerHandle, TransportSpec } from './types.ts'
import { cborCodec } from './codec.ts'
import { DEFAULT_CHUNK, DEFAULT_HEARTBEAT_MS } from './framing.ts'
import type { PeerHost } from './peer.ts'
import { PeerConnectionTable } from './tables.ts'
import { NACTEvent } from './events.ts'
import { nactInternal } from './errors.ts'

/** Browser = absence of process.versions.node (a bundled worker has no window but is still a browser). */
const isBrowser = typeof process === 'undefined' || !(process as any)?.versions?.node

export class NACT {
  private peerTable = new PeerConnectionTable()
  /** One closer per listen(); carrier-agnostic. */
  private closers: Array<() => Promise<void>> = []
  napp: NApp
  private codec: Codec
  private host: PeerHost

  constructor(napp: NApp, codec: Codec = cborCodec) {
    this.napp = napp
    this.codec = codec
    // The four callbacks the peer factories need; table bookkeeping lives HERE.
    this.host = {
      codec: this.codec,
      deliver: (msg, peer) => this.napp.nacp.inbound(msg, peer),
      fail: (peer, reason) => {
        this.napp.bus.emit(NACTEvent.peerError, { peerId: peer.id, reason })
        if (peer.terminate) peer.terminate()
        else peer.close()   // no force-drop (browser ws): graceful close still lands on 'close' → gone
      },
      gone: (peer) => {
        // Announce only if THIS call removed the row — a peer can reach here twice.
        if (this.dropPeer(peer.id)) this.napp.bus.emit(NACTEvent.peerDisconnect, { peerId: peer.id })
      },
      arrived: (peer) => {
        this.addPeer(peer)
        this.napp.bus.emit(NACTEvent.peerConnect, { peerId: peer.id })
      },
    }
  }

  addPeer(peer: Peer) { this.peerTable.add(peer) }
  getPeer(peerId: NACTPeerId): Peer | undefined { return this.peerTable.getPeerbyPeerId(peerId) }
  dropPeer(peerId: NACTPeerId): boolean { return this.peerTable.deletePeerbyPeerId(peerId) }
  listPeerId(): NACTPeerId[] { return this.peerTable.listPeerId() }

  /** Send to a physical connection by peerId; false when there is no such peer. */
  sendToPeer(peerId: NACTPeerId, msg: NACPMessage): boolean {
    const peer = this.peerTable.getPeerbyPeerId(peerId)
    if (!peer) return false
    peer.send(msg)
    return true
  }

  /** Gracefully close ONE connection; resolves once the row is gone and disconnect announced. */
  closePeer(peerId: NACTPeerId): Promise<boolean> {
    const peer = this.peerTable.getPeerbyPeerId(peerId)
    if (!peer) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      // Listen BEFORE closing: a carrier may fire 'close' synchronously for an already-dead socket.
      const listenId = this.napp.bus.listen(NACTEvent.peerDisconnect, (p: { peerId: NACTPeerId }) => {
        if (p.peerId !== peerId) return
        this.napp.bus.off(listenId)
        resolve(true)
      })
      // A dead socket may never emit 'close'; drop the row ourselves so the caller is not stranded.
      try { peer.close() } catch { this.host.gone(peer) }
    })
  }

  private chunkOf(spec: TransportSpec): number {
    return (spec.opt as any).chunkSize ?? DEFAULT_CHUNK[spec.type]
  }

  /** unset → default (ON); `-1` → undefined (= off). */
  private heartbeatOf(spec: TransportSpec): number | undefined {
    const ms = (spec.opt as any).heartbeat ?? DEFAULT_HEARTBEAT_MS
    return ms === -1 ? undefined : ms
  }

  /** Expose an entry on a carrier; each accepted connection mints a Peer handed to onPeer.
   *  Throws browser-no-server in a browser for EVERY carrier. */
  async listen(spec: TransportSpec, onPeer: (peer: Peer) => void = () => {}): Promise<ServerHandle> {
    if (isBrowser)
      throw nactInternal('browser-no-server',
        `NACT cannot listen in a browser (asked for '${spec.type}'): a browser has no server capability on any carrier`)

    const chunkSize = this.chunkOf(spec)
    const heartbeat = this.heartbeatOf(spec)

    if (spec.type === 'unix' || spec.type === 'tcp') {
      const { listenNet } = await import('./listen.net.ts')
      const { handle } = await listenNet(this.host, spec, chunkSize, heartbeat, onPeer)
      this.closers.push(handle.close)
      return handle
    }

    const { listenWs } = await import('./listen.ws.ts')
    const { handle } = await listenWs(this.host, spec, chunkSize, heartbeat, onPeer)
    this.closers.push(handle.close)
    return handle
  }

  /** Dial out; the register handshake is the caller's business. tcp/unix throw browser-no-carrier in a browser. */
  async dial(spec: TransportSpec): Promise<Peer> {
    const chunkSize = this.chunkOf(spec)
    const heartbeat = this.heartbeatOf(spec)

    if (spec.type === 'unix' || spec.type === 'tcp') {
      if (isBrowser)
        throw nactInternal('browser-no-carrier',
          `NACT cannot dial '${spec.type}' in a browser: no raw-socket API exists — use { type: 'ws' }`)
      const { dialNet } = await import('./listen.net.ts')
      return dialNet(this.host, spec, chunkSize, heartbeat)
    }

    const { dialWs } = await import('./listen.ws.ts')
    return dialWs(this.host, spec, chunkSize, heartbeat)
  }

  /** Drop every connection and server entry. */
  async terminate() {
    // Clear the table first so the sockets' 'close' events find no row and stay quiet.
    for (const p of this.peerTable.listPeer()) { try { p.close() } catch { /* already dead */ } }
    this.peerTable.clear()
    await Promise.all(this.closers.map(close => close()))
    this.closers = []
  }
}
