/** NACT core: Provider registration, Peer lifecycle, framing and NACP delivery. */

import type { NACPMessage } from '../NACP/types.ts'
import type { NApp } from '../NApp/NApp.ts'
import type {
  ClientTransportProvider, Codec, NACTPeerId, Peer, ServerHandle, ServerTransportProvider,
  TransportChannel, TransportProvider, TransportSpec,
} from './types.ts'
import { cborCodec } from './codec.ts'
import type { PeerHost } from './peer.ts'
import { PeerConnectionTable } from './tables.ts'
import { NACTEvent } from './events.ts'
import { nactInternal } from './errors.ts'
import { makeChannelPeer } from './channel.ts'
import { CustomTransportProvider } from './provider.ts'

export class NACT {
  private peerTable = new PeerConnectionTable()
  /** One closer per listen(); carrier-agnostic. */
  private closers: Array<() => Promise<void>> = []
  private serverProviders = new Map<string, ServerTransportProvider<string, unknown>>()
  private clientProviders = new Map<string, ClientTransportProvider<string, unknown>>()
  private customProviders = new Set<string>()
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

  use(provider: TransportProvider): void {
    if (provider.role === 'custom') {
      if (this.customProviders.has(provider.type))
        throw nactInternal('provider-already-registered', `custom Provider '${provider.type}' is already registered`)
      if (!(provider instanceof CustomTransportProvider))
        throw nactInternal('unsupported-custom-provider', 'custom role is reserved for CustomTransportProvider')
      provider.attach((channel, chunkSize) => this.acceptChannel(channel, chunkSize).id)
      this.customProviders.add(provider.type)
      return
    }

    if (provider.role === 'server') {
      if (this.serverProviders.has(provider.type))
        throw nactInternal('provider-already-registered', `server Provider '${provider.type}' is already registered`)
      this.serverProviders.set(provider.type, provider as ServerTransportProvider<string, unknown>)
      return
    }
    if (this.clientProviders.has(provider.type))
      throw nactInternal('provider-already-registered', `client Provider '${provider.type}' is already registered`)
    this.clientProviders.set(provider.type, provider as ClientTransportProvider<string, unknown>)
  }

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

  private acceptChannel(channel: TransportChannel, chunkSize: number): Peer {
    return makeChannelPeer(this.host, channel, chunkSize)
  }

  private providerNotFound(role: 'server' | 'client', type: string): never {
    throw nactInternal('provider-not-found', `${role} Provider '${type}' is not registered`)
  }

  async listen(spec: TransportSpec, onPeer: (peer: Peer) => void = () => {}): Promise<ServerHandle> {
    const provider = this.serverProviders.get(spec.type) ?? this.providerNotFound('server', spec.type)
    const chunkSize = spec.nact?.chunkSize ?? provider.defaultChunkSize
    const handle = await provider.listen(spec.provider, (channel) => onPeer(this.acceptChannel(channel, chunkSize)))
    this.closers.push(handle.close)
    return handle
  }

  async dial(spec: TransportSpec): Promise<Peer> {
    const provider = this.clientProviders.get(spec.type) ?? this.providerNotFound('client', spec.type)
    const channel = await provider.dial(spec.provider)
    return this.acceptChannel(channel, spec.nact?.chunkSize ?? provider.defaultChunkSize)
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
