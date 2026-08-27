/**
 * NACT types — the transport-layer shapes NACT owns: which carrier + address (TransportSpec), the uniform
 * physical-connection abstraction (Peer), the wire codec, and the server handle.
 *
 * Ownership: these belong to NACT because they describe TRANSPORT, not protocol. NACP imports NACTPeerId
 * from here (its four tables address sends by peerId); NACT imports NACPMessage from NACP/types.ts (a
 * peer sends/receives whole messages). Type-only imports are erased at compile time — the two layers may
 * import each other's TYPES freely; what neither does is import the other's IMPLEMENTATION. Sibling
 * implementations are reached through NApp: `napp.nacp.inbound` one way, `napp.nact.sendToPeer` the other.
 */

import type { NACPMessage } from '../NACP/types.ts'
export type { NACPMessage }   // re-exported so NACT-internal modules import message types from one place

// ============================================================
// Carrier + address. No Client/Server distinction: one TransportSpec describes both "expose an entry"
//   (server[]) and "dial out" (connect target). Direction is decided by where it's used, not by the type.
// ============================================================

export type Transport = 'ws' | 'tcp' | 'unix'

/** CBOR encoding mode, not a separate compression layer. MVP is fixed 'none' (standard CBOR); the field
 *  is a reserved negotiation slot (see the NACT doc, "wire format: CBOR") that NACT does not read yet. */
export type CompressionKind = 'none' | 'cbor-records'

/** Heartbeat interval in ms — ONE number, no separate timeout. `-1` disables it.
 *
 *  The deadline is the next interval: a ping goes out, and if its pong has not arrived by the time the next
 *  ping is due, the connection is declared dead. That is the whole mechanism, so a second timeout parameter
 *  would have nothing left to mean. Worst-case detection is therefore 2× the interval.
 *
 *  Lives entirely inside NACT — nothing above sees it. ws uses protocol ping/pong frames and fails the peer
 *  with 'heartbeat-timeout'; tcp/unix hand the job to OS-level TCP keepalive. Default is
 *  DEFAULT_HEARTBEAT_MS (ON): a silently half-open connection is worse than a spurious drop, and no layer
 *  above NACT can detect one. */
export type HeartbeatMs = number

export interface ServerOptBase {
  compression?: CompressionKind   // declare the mode; actually enabling it is NACT's job
  heartbeat?: HeartbeatMs         // ms between pings; omitted → DEFAULT_HEARTBEAT_MS, -1 → off
  chunkSize?: number              // LOCAL send-side fragment threshold in bytes. default: unix no-split / tcp,ws 100MB
}

export interface WSOpt   extends ServerOptBase { ip: string; port: number; path?: string }  // path: ws sub-route, ws only
export interface TCPOpt  extends ServerOptBase { ip: string; port: number }
export interface UnixOpt extends ServerOptBase { socketPath: string }

export type TransportSpec =
  | { type: 'ws';   opt: WSOpt }
  | { type: 'tcp';  opt: TCPOpt }
  | { type: 'unix'; opt: UnixOpt }

// ============================================================
// Peer — NACT's uniform physical-connection abstraction. This is the whole point of the layer: ws/tcp/unix
//   collapse into one {id, send, close} shape so NACP addresses connections without knowing the carrier.
// ============================================================

/** NACT's physical connection id (uuid, minted at connect time). Owned by NACT; NACP uses it to address
 *  sends without touching the socket. The appId↔peerId mapping lives in NACP, never here. */
export type NACTPeerId = string

/** A physical connection, carrier-abstracted. Sends/receives OBJECTS — the codec is internal, applied at
 *  the wire edge, so every layer above NACT only ever handles messages, never bytes.
 *  `appId` is deliberately absent: identity is NACP's business (its appId↔peerId table).
 *
 *  `close` is mandatory, `terminate` optional: every carrier can hang up politely, but not every one exposes
 *  a yank-the-cord. Both stock peers (net, ws) implement both, so the optional half is headroom for a future
 *  carrier rather than a concession to an existing one. */
export interface Peer {
  id: NACTPeerId                     // physical connection id
  send(msg: NACPMessage): void       // object → internal codec.encode → chunked → wire
  close(): void                      // graceful close (mandatory)
  terminate?(): void                 // force-drop (optional; carriers without it degrade to close)
}

/** Codec at the wire edge — CBOR (cbor-x). encode → binary bytes (Buffers ride as bytes, no base64).
 *  NACT-internal only: it is the single place in the stack where objects become bytes.
 *  Takes/returns NACPMessage: the encoder walks the payload without knowing what any field MEANS, which is
 *  the precise sense in which a payload is semantically opaque yet physically traversable. */
export interface Codec {
  encode(msg: NACPMessage): Uint8Array
  decode(data: Uint8Array): NACPMessage
}

/** Handle returned by listen() — closes that one server entry. */
export interface ServerHandle { close(): Promise<void> }
