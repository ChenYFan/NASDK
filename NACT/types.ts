/**
 * NACT types — TransportSpec (carrier + address), Peer (uniform physical connection), Codec, ServerHandle.
 */

import type { NACPMessage } from '../NACP/types.ts'
export type { NACPMessage }   // re-exported so NACT-internal modules import message types from one place

// ============================================================
// Carrier + address. No Client/Server distinction: direction is decided by where the spec is used.
// ============================================================

export type Transport = 'ws' | 'tcp' | 'unix'

/** CBOR encoding mode; MVP is fixed 'none' (reserved negotiation slot, NACT does not read it yet). */
export type CompressionKind = 'none' | 'cbor-records'

/** Heartbeat interval in ms; `-1` disables. No separate timeout — the deadline IS the next interval
 *  (worst-case detection 2×). ws uses protocol ping/pong; tcp/unix use OS TCP keepalive. */
export type HeartbeatMs = number

export interface ServerOptBase {
  compression?: CompressionKind
  heartbeat?: HeartbeatMs         // omitted → DEFAULT_HEARTBEAT_MS, -1 → off
  chunkSize?: number              // LOCAL send-side fragment threshold in bytes
}

export interface WSOpt   extends ServerOptBase { ip: string; port: number; path?: string }
export interface TCPOpt  extends ServerOptBase { ip: string; port: number }
export interface UnixOpt extends ServerOptBase { socketPath: string }

export type TransportSpec =
  | { type: 'ws';   opt: WSOpt }
  | { type: 'tcp';  opt: TCPOpt }
  | { type: 'unix'; opt: UnixOpt }

// ============================================================
// Peer — NACT's uniform physical-connection abstraction {id, send, close}.
// ============================================================

/** Physical connection id (uuid); NACP uses it to address sends. appId mapping lives in NACP. */
export type NACTPeerId = string

/** A physical connection, carrier-abstracted; sends/receives OBJECTS (codec applied at the wire edge).
 *  `terminate` optional: carriers without a force-drop degrade to close(). */
export interface Peer {
  id: NACTPeerId
  send(msg: NACPMessage): void
  close(): void
  terminate?(): void
}

/** Codec at the wire edge — CBOR (cbor-x); Buffers ride as bytes, no base64. */
export interface Codec {
  encode(msg: NACPMessage): Uint8Array
  decode(data: Uint8Array): NACPMessage
}

/** Handle returned by listen() — closes that one server entry. */
export interface ServerHandle { close(): Promise<void> }
