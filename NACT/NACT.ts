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
 * Everything it needs from outside is PUBLIC on NApp, so it holds only a reverse reference: the bus for its own
 * nact:* events and `inbound` — its sibling NACP's single inbound face. It cannot reach anything else.
 *
 * ── BROWSER ────────────────────────────────────────────────────────────────────────────────────────────
 * This file itself is browser-safe: it imports NO `node:*` module. The carrier code that cannot run in a
 * browser lives behind carrier-scoped modules reached only on the path that needs them:
 *
 *   ws            → listen.ws.ts    dial is browser-safe; listen dynamically imports node:http + ws
 *   tcp / unix    → listen.net.ts   Node only, loaded by dynamic import so a bundler never resolves node:net
 *
 * A browser gets ws-client only, and asking for anything else FAILS LOUDLY rather than silently degrading:
 * `listen()` throws `browser-no-server` for every carrier, and `dial()` throws `browser-no-carrier` for
 * tcp/unix. Both are thrown before any dynamic import is attempted, so the error is about capability, not a
 * confusing module-resolution failure.
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

/** Is this runtime a browser? Decided by the ABSENCE of Node's process.versions.node rather than the presence
 *  of `window`: a bundled worker has no `window` but is still a browser runtime, and Electron's renderer has
 *  both. What actually matters here is "can I require node:net", and that is what this asks. */
const isBrowser = typeof process === 'undefined' || !(process as any)?.versions?.node

export class NACT {
  /** NACT's ONE state landing point: peerId → peer (PHYSICAL only; appId↔peerId lives in NACP's
   *  PeerAppConnectionTable). An object with a sheet inside rather than a bare Map, same as NACP's four. */
  private peerTable = new PeerConnectionTable()
  /** Closers for every entry this NACT exposed, one per `listen()`. Carrier-agnostic on purpose: a
   *  `net.Server` and a ws server + its http host both collapse to "one function that resolves when shut",
   *  so this file never names a carrier type and stays free of Node imports. */
  private closers: Array<() => Promise<void>> = []
  /** Reverse reference — NApp's PUBLIC face, and the only thing NACT holds from above: `this.napp.bus` for its
   *  own nact:* events, `this.napp.nacp.inbound` to hand messages up. Both are read at call time, so no
   *  construction cycle forms. NACP holds exactly the same one reference — neither child gets a capability box. */
  napp: NApp
  private codec: Codec
  private host: PeerHost

  constructor(napp: NApp, codec: Codec = cborCodec) {
    this.napp = napp
    this.codec = codec
    // The four callbacks the peer factories need. Table bookkeeping lives HERE (the factories stay pure):
    // every exit path — clean close and transport fault alike — drops the peer, so the table cannot leak.
    this.host = {
      codec: this.codec,
      deliver: (msg, peer) => this.napp.nacp.inbound(msg, peer),
      // A transport fault: report it, then force the connection down. Deliberately does NOT drop the row —
      // `terminate()` makes the carrier fire 'close', which reaches `gone`, which is the ONE place that drops
      // and announces. Dropping here would beat `gone` to it and swallow the disconnect, leaving NACP
      // believing the appId is still live. So an error is always FOLLOWED by a disconnect.
      fail: (peer, reason) => {
        this.napp.bus.emit(NACTEvent.peerError, { peerId: peer.id, reason })
        if (peer.terminate) peer.terminate()
        else peer.close()   // carrier without a force-drop (ws in a browser): a graceful close still lands on 'close' → gone
      },
      gone: (peer) => {
        // Announce ONLY if this call is the one that actually removed the row. A peer can reach here twice
        // (a carrier firing 'close' after we already dropped it on a fault, say), and disconnect must be
        // announced exactly once — NACP clears its appId and subscriptions off this event.
        if (this.dropPeer(peer.id)) this.napp.bus.emit(NACTEvent.peerDisconnect, { peerId: peer.id })
      },
      // Register BEFORE announcing: a listener reacting to nact:peer:connect with an immediate
      // sendToPeer(peerId) must find the peer already in the table.
      arrived: (peer) => {
        this.addPeer(peer)
        this.napp.bus.emit(NACTEvent.peerConnect, { peerId: peer.id })
      },
    }
  }

  // ── peer table (thin forwards onto PeerConnectionTable; kept on NACT because they are the layer's API) ──
  addPeer(peer: Peer) { this.peerTable.add(peer) }
  getPeer(peerId: NACTPeerId): Peer | undefined { return this.peerTable.getPeerbyPeerId(peerId) }
  dropPeer(peerId: NACTPeerId): boolean { return this.peerTable.deletePeerbyPeerId(peerId) }
  listPeerId(): NACTPeerId[] { return this.peerTable.listPeerId() }

  /** Send a message to a physical connection by peerId. NACP reaches this as `napp.nact.sendToPeer(...)`.
   *  Returns false when there is no such peer — NACP turns that into nacp:internal:route:error. */
  sendToPeer(peerId: NACTPeerId, msg: NACPMessage): boolean {
    const peer = this.peerTable.getPeerbyPeerId(peerId)
    if (!peer) return false
    peer.send(msg)
    return true
  }

  /** Gracefully close ONE connection, resolving once it is actually gone: socket shut, row out of the peer
   *  table, `nact:peer:disconnect` emitted. Named `closePeer`, not `close`, for two reasons: it joins the
   *  per-peer family (`addPeer`/`getPeer`/`dropPeer`/`sendToPeer`), and a bare `close()` on a transport layer
   *  reads as "shut the whole thing down" — that verb is `terminate()`. Resolves `false` when there was no
   *  such peer (nothing to wait for).
   *
   *  It awaits rather than fires-and-forgets because socket close is asynchronous: the row is removed by the
   *  carrier's own 'close' event → `gone` → dropPeer + announce. Returning before that would hand back a
   *  peerId still in the table. Every exit path (this, transport fault, remote hang-up) funnels through that
   *  same one place, so a row leaving the table and that departure being announced stay the same event. */
  closePeer(peerId: NACTPeerId): Promise<boolean> {
    const peer = this.peerTable.getPeerbyPeerId(peerId)
    if (!peer) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      // Settle on the disconnect this close produces. Listening BEFORE calling `peer.close()`: a carrier may
      // fire 'close' synchronously for an already-dead socket, and we must not miss it.
      const listenId = this.napp.bus.listen(NACTEvent.peerDisconnect, (p: { peerId: NACTPeerId }) => {
        if (p.peerId !== peerId) return
        this.napp.bus.off(listenId)
        resolve(true)
      })
      // A dead socket may never emit 'close'; drop the row ourselves so the caller is not stranded. `gone`
      // announces only when it is the call that removed the row, so the normal path still fires exactly once.
      try { peer.close() } catch { this.host.gone(peer) }
    })
  }

  private chunkOf(spec: TransportSpec): number {
    return (spec.opt as any).chunkSize ?? DEFAULT_CHUNK[spec.type]
  }

  /** Resolve the heartbeat interval for a spec: unset → the default (ON), `-1` → off. Returns undefined for
   *  "off" so the peer factories keep one falsy check instead of re-testing the sentinel. */
  private heartbeatOf(spec: TransportSpec): number | undefined {
    const ms = (spec.opt as any).heartbeat ?? DEFAULT_HEARTBEAT_MS
    return ms === -1 ? undefined : ms
  }

  /**
   * Expose an entry on a carrier. Each accepted connection mints a Peer (already in the table) and is
   * handed to onPeer — the handshake itself is the caller's business, not NACT's.
   *
   * Throws `browser-no-server` in a browser, for EVERY carrier: being a server is not a capability a browser
   * has for any transport, so this is refused up front rather than failing later on a module import. The check
   * lives here rather than in NApp because "which carriers can this runtime expose" is transport knowledge.
   */
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

  /**
   * Dial out. The Peer is minted (and table-registered) for this one connection; the register handshake is
   * the caller's (NApp.connect's) business.
   *
   * In a browser only `ws` is dialable — tcp/unix throw `browser-no-carrier`. That is a hard runtime limit
   * (no raw-socket API exists), so it is reported as such instead of letting a `node:net` import fail with
   * something that looks like a build problem.
   */
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

  /** Drop EVERY connection and every server entry this NACT holds. Dead peers are tolerated (try/catch) —
   *  teardown must finish. Named `terminate` to match NApp and NACP: across all three, `terminate` is the
   *  full teardown. Closing ONE thing is a different verb — see `closePeer(peerId)`. */
  async terminate() {
    // Clearing the table up front is what makes teardown QUIET: the sockets' 'close' events still arrive, but
    // `gone` finds no row to remove and therefore announces nothing. Deliberate — a whole-layer teardown is
    // one event at the NApp level, not N per-peer disconnects that nobody can act on any more.
    for (const p of this.peerTable.listPeer()) { try { p.close() } catch { /* already dead */ } }
    this.peerTable.clear()
    await Promise.all(this.closers.map(close => close()))
    this.closers = []
  }
}
