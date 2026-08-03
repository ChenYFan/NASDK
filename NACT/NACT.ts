/**
 * NACT — the transport face, one of NASDK's three parallel stack members (NApp / NACP / NACT). One job:
 * flatten ws/tcp/unix into a uniform Peer abstraction
 * ({id, send, close}) and hand the protocol layer a physical connection it can address by id, so NACP
 * runs ONE code path regardless of carrier.
 *
 * What NACT owns: the peerId→peer table, the wire codec, fragmentation/reassembly, connection lifecycle.
 * What NACT never touches: appId (that mapping is NACP's), protocol semantics (it never switches on
 * msg.type or reads from/to), payload meaning, authentication, routing decisions. It reads SHAPE, not
 * meaning — CBOR-walking a payload to turn it into bytes is not reading it.
 *
 * Everything it needs from outside arrives through a two-entry ref box (NACTPrivateRef): `emit` for its own
 * nact:* events and `inbound` — its sibling NACP's single inbound face. It cannot reach anything else.
 */

import net from 'node:net'
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { NACPMessage } from '../NACP/types.ts'
import type { NACTPrivateRef } from '../NApp/types.ts'
import type { Codec, NACTPeerId, Peer, ServerHandle, TransportSpec } from './types.ts'
import { cborCodec } from './codec.ts'
import { DEFAULT_CHUNK, MAX_FRAME_SIZE } from './framing.ts'
import { makeNetPeer, makeWsPeer, type PeerHost } from './peer.ts'
import { NACTEvent } from './events.ts'

export class NACT {
  private peers = new Map<NACTPeerId, Peer>()   // peerId → peer (PHYSICAL only; appId↔peerId lives in NACP)
  private servers: net.Server[] = []
  private wsServers: WebSocketServer[] = []
  private httpServers: http.Server[] = []
  private ref: NACTPrivateRef
  private codec: Codec
  private host: PeerHost

  constructor(ref: NACTPrivateRef, codec: Codec = cborCodec) {
    this.ref = ref
    this.codec = codec
    // The four callbacks the peer factories need. Table bookkeeping lives HERE (the factories stay pure):
    // every exit path — clean close and transport fault alike — drops the peer, so the table cannot leak.
    this.host = {
      codec: this.codec,
      deliver: (msg, peer) => this.ref.inbound(msg, peer),
      fail: (peer, reason) => {
        this.ref.emit(NACTEvent.peerError, { peerId: peer.id, reason })
        this.dropPeer(peer.id)
        peer.terminate?.()
      },
      gone: (peer) => {
        this.dropPeer(peer.id)
        this.ref.emit(NACTEvent.peerDisconnect, { peerId: peer.id })
      },
      // Register BEFORE announcing: a listener reacting to nact:peer:connect with an immediate
      // sendToPeer(peerId) must find the peer already in the table.
      arrived: (peer) => {
        this.addPeer(peer)
        this.ref.emit(NACTEvent.peerConnect, { peerId: peer.id })
      },
    }
  }

  // ── peerId → peer table ──
  addPeer(peer: Peer) { this.peers.set(peer.id, peer) }
  getPeer(peerId: NACTPeerId): Peer | undefined { return this.peers.get(peerId) }
  dropPeer(peerId: NACTPeerId): boolean { return this.peers.delete(peerId) }
  peerIds(): NACTPeerId[] { return [...this.peers.keys()] }

  /** Send a message to a physical connection by peerId. NACP reaches this through its ref box (sendToPeer).
   *  Returns false when there is no such peer — NACP turns that into nacp:internal:error:route. */
  sendToPeer(peerId: NACTPeerId, msg: NACPMessage): boolean {
    const peer = this.peers.get(peerId)
    if (!peer) return false
    peer.send(msg)
    return true
  }

  private chunkOf(spec: TransportSpec): number {
    return (spec.opt as any).chunkSize ?? DEFAULT_CHUNK[spec.type]
  }

  /** Expose an entry on a carrier. Each accepted connection mints a Peer (already in the table) and is
   *  handed to onPeer — the handshake itself is the caller's business, not NACT's. */
  async listen(spec: TransportSpec, onPeer: (peer: Peer) => void = () => {}): Promise<ServerHandle> {
    const chunkSize = this.chunkOf(spec)

    if (spec.type === 'unix' || spec.type === 'tcp') {
      const server = net.createServer((sock) => onPeer(makeNetPeer(this.host, sock, chunkSize)))
      this.servers.push(server)
      const listenArg: any = spec.type === 'unix' ? spec.opt.socketPath : { port: spec.opt.port, host: spec.opt.ip }
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(listenArg, () => { server.off('error', reject); resolve() })
      })
      return { close: () => new Promise<void>((r) => server.close(() => r())) }
    }

    // ws: own an http server and attach a WebSocketServer to it.
    // (Borrowing an EXTERNAL http server — the attach form for Daemon/Web — is not implemented yet; see A6.)
    const hs = http.createServer()
    const wss = new WebSocketServer({ server: hs, path: spec.opt.path, maxPayload: MAX_FRAME_SIZE, perMessageDeflate: false })
    wss.on('connection', (ws) => onPeer(makeWsPeer(this.host, ws, chunkSize)))
    this.wsServers.push(wss); this.httpServers.push(hs)
    await new Promise<void>((resolve, reject) => {
      hs.once('error', reject)
      hs.listen(spec.opt.port, spec.opt.ip, () => { hs.off('error', reject); resolve() })
    })
    return { close: () => new Promise<void>((r) => { wss.close(() => hs.close(() => r())) }) }
  }

  /** Dial out. The Peer is minted (and table-registered) for this one connection; the register handshake is
   *  the caller's (NApp.connect's) business. */
  async dial(spec: TransportSpec): Promise<Peer> {
    const chunkSize = this.chunkOf(spec)

    if (spec.type === 'unix' || spec.type === 'tcp') {
      const connArg: any = spec.type === 'unix' ? spec.opt.socketPath : { port: spec.opt.port, host: spec.opt.ip }
      const sock: net.Socket = await new Promise((resolve, reject) => {
        const s = net.createConnection(connArg)
        s.once('connect', () => { s.off('error', reject); resolve(s) })
        s.once('error', reject)
      })
      return makeNetPeer(this.host, sock, chunkSize)
    }

    const url = `ws://${spec.opt.ip}:${spec.opt.port}${spec.opt.path ?? ''}`
    const ws: WebSocket = await new Promise((resolve, reject) => {
      const w = new WebSocket(url, { maxPayload: MAX_FRAME_SIZE, perMessageDeflate: false })
      w.once('open', () => { w.off('error', reject); resolve(w) })
      w.once('error', reject)
    })
    return makeWsPeer(this.host, ws, chunkSize)
  }

  /** Close every peer and every server entry. Dead peers are tolerated (try/catch) — shutdown must finish. */
  async close() {
    for (const p of this.peers.values()) { try { p.close() } catch { /* already dead */ } }
    this.peers.clear()
    await Promise.all([
      ...this.servers.map(s => new Promise<void>(r => s.close(() => r()))),
      ...this.wsServers.map((wss, i) => new Promise<void>(r => wss.close(() => this.httpServers[i].close(() => r())))),
    ])
    this.servers = []; this.wsServers = []; this.httpServers = []
  }
}
