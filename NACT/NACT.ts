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
  private closers = new Set<() => Promise<void>>()
  private stopped = false
  private termination?: Promise<void>
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
    this.assertActive()
    this.chunkSize(provider.defaultChunkSize)
    if (!provider.type || !['custom', 'server', 'client'].includes(provider.role))
      throw nactInternal('invalid-provider', 'Provider requires a type and a valid role')
    if (provider.role === 'server' && typeof (provider as ServerTransportProvider).listen !== 'function'
      || provider.role === 'client' && typeof (provider as ClientTransportProvider).dial !== 'function')
      throw nactInternal('invalid-provider', 'Provider must implement its role method')
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
    if (this.stopped) {
      void Promise.resolve(channel.terminate ? channel.terminate() : channel.close()).catch(() => {})
      this.assertActive()
    }
    return makeChannelPeer(this.host, channel, chunkSize)
  }

  private assertActive() {
    if (this.stopped) throw nactInternal('transport-stopped', 'NACT is terminated')
  }

  private chunkSize(value: number): number {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31)
      throw nactInternal('invalid-chunk-size', 'chunkSize must be an integer between 1 and 2GiB')
    return value
  }

  private providerNotFound(role: 'server' | 'client', type: string): never {
    throw nactInternal('provider-not-found', `${role} Provider '${type}' is not registered`)
  }

  async listen(spec: TransportSpec, onPeer: (peer: Peer) => void = () => {}): Promise<ServerHandle> {
    this.assertActive()
    const provider = this.serverProviders.get(spec.type) ?? this.providerNotFound('server', spec.type)
    const chunkSize = this.chunkSize(spec.nact?.chunkSize ?? provider.defaultChunkSize)
    const handle = await provider.listen(spec.provider, (channel) => {
      if (this.stopped) {
        try { void Promise.resolve(channel.terminate ? channel.terminate() : channel.close()).catch(() => {}) }
        catch { /* shutdown already owns this connection */ }
        return
      }
      onPeer(this.acceptChannel(channel, chunkSize))
    })
    if (this.stopped) { await handle.close(); this.assertActive() }
    let closing: Promise<void> | undefined
    const close = () => closing ??= Promise.resolve().then(() => handle.close()).finally(() => this.closers.delete(close))
    this.closers.add(close)
    return { close }
  }

  async dial(spec: TransportSpec): Promise<Peer> {
    this.assertActive()
    const provider = this.clientProviders.get(spec.type) ?? this.providerNotFound('client', spec.type)
    const chunkSize = this.chunkSize(spec.nact?.chunkSize ?? provider.defaultChunkSize)
    const channel = await provider.dial(spec.provider)
    return this.acceptChannel(channel, chunkSize)
  }

  /** Drop every connection and server entry. */
  terminate(): Promise<void> {
    if (this.termination) return this.termination
    this.stopped = true
    // Clear the table first so the sockets' 'close' events find no row and stay quiet.
    const peers = this.peerTable.listPeer()
    this.peerTable.clear()
    for (const p of peers) { try { if (p.terminate) p.terminate(); else p.close() } catch { /* already dead */ } }
    this.termination = Promise.allSettled([...this.closers].map(close => close())).then(results => {
      const errors = results.filter(r => r.status === 'rejected').map(r => r.reason)
      if (errors.length) throw new AggregateError(errors, 'Provider shutdown failed')
    })
    return this.termination
  }
}
