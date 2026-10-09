import type { NACPMessage } from '../NACP/types.ts'
import type { NApp } from '../NApp/NApp.ts'
import type {
  Channel, ClientProvider, Codec, NACTPeerId, Peer,
  TransportSpec,
  ServerProvider, ServerHandle,
} from './types.ts'
import { cborCodec } from './codec.ts'
import type { PeerHost } from './peer.ts'
import { PeerConnectionTable } from './tables.ts'
import { NACTEvent } from './events.ts'
import { errorDetail } from '../types.ts'
import { NACTError, codeOf, nactInternal } from './errors.ts'
import { makeChannelPeer } from './channel.ts'

export class NACT {
  private peerTable = new PeerConnectionTable()
  private closers: Array<() => Promise<void>> = []
  private serverProviders = new Map<string, ServerProvider<string, unknown>>()
  private clientProviders = new Map<string, ClientProvider<string, unknown>>()
  napp: NApp
  private codec: Codec
  private host: PeerHost

  constructor(napp: NApp, codec: Codec = cborCodec) {
    this.napp = napp
    this.codec = codec
    this.host = {
      codec: this.codec,
      deliver: (msg, peer) => this.napp.nacp.inbound(msg, peer),
      fail: (peer, reason) => {
        this.napp.bus.emit(NACTEvent.peerError, { peerId: peer.id, reason })
        if (peer.terminate) peer.terminate()
        else peer.close()   // no force-drop (browser ws); close still fires 'close' → gone
      },
      gone: (peer) => {
        // Emit only if THIS call dropped the row; gone can fire twice per peer.
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

  use(provider: ServerProvider<string, unknown> | ClientProvider<string, unknown>): void {
    if (provider.role === 'server') {
      if (this.serverProviders.has(provider.type))
        throw nactInternal('provider-already-registered', `server Provider '${provider.type}' is already registered`)
      this.serverProviders.set(provider.type, provider)
      return
    }
    if (this.clientProviders.has(provider.type))
      throw nactInternal('provider-already-registered', `client Provider '${provider.type}' is already registered`)
    this.clientProviders.set(provider.type, provider)
  }

  async sendToPeer(peerId: NACTPeerId, msg: NACPMessage): Promise<boolean> {
    const peer = this.peerTable.getPeerbyPeerId(peerId)
    if (!peer) return false
    await peer.send(msg)
    return true
  }

  closePeer(peerId: NACTPeerId): Promise<boolean> {
    const peer = this.peerTable.getPeerbyPeerId(peerId)
    if (!peer) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      // Listen before close: a carrier may fire 'close' synchronously.
      const listenId = this.napp.bus.listen(NACTEvent.peerDisconnect, (p: { peerId: NACTPeerId }) => {
        if (p.peerId !== peerId) return
        this.napp.bus.off(listenId)
        resolve(true)
      })
      // A dead socket may never emit 'close'; drop the row ourselves.
      try { peer.close() } catch { this.host.gone(peer) }
    })
  }

  private acceptChannel(channel: Channel, chunkSize: number): Peer {
    return makeChannelPeer(this.host, channel, chunkSize)
  }

  private providerNotFound(role: 'server' | 'client', type: string): never {
    throw nactInternal('provider-not-found', `${role} Provider '${type}' is not registered`)
  }

  private async viaProvider<T>(fallback: string, what: string, call: () => Promise<T>): Promise<T> {
    try { return await call() } catch (reason) {
      if (reason instanceof NACTError) throw reason
      throw nactInternal(codeOf(reason, fallback), `${what}: ${errorDetail(reason)}`, reason)
    }
  }

  async listen(spec: TransportSpec, onPeer: (peer: Peer) => void = () => {}): Promise<ServerHandle> {
    const provider = this.serverProviders.get(spec.type) ?? this.providerNotFound('server', spec.type)
    const chunkSize = spec.nact?.chunkSize ?? provider.defaultChunkSize
    const handle = await this.viaProvider('listen-failed', `server Provider '${spec.type}' failed to listen`,
      () => provider.listen(spec.provider, (channel) => onPeer(this.acceptChannel(channel, chunkSize))))
    this.closers.push(handle.close)
    return handle
  }

  async dial(spec: TransportSpec): Promise<Peer> {
    const provider = this.clientProviders.get(spec.type) ?? this.providerNotFound('client', spec.type)
    const channel = await this.viaProvider('dial-failed', `client Provider '${spec.type}' failed to dial`,
      () => provider.dial(spec.provider))
    return this.acceptChannel(channel, spec.nact?.chunkSize ?? provider.defaultChunkSize)
  }

  async terminate() {
    // Clear first so the sockets' 'close' events find no row and stay quiet.
    for (const p of this.peerTable.listPeer()) { try { p.close() } catch { /* already dead */ } }
    this.peerTable.clear()
    await Promise.all(this.closers.map(close => close()))
    this.closers = []
  }
}
