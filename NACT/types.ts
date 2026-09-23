/** NACT core types. Physical addresses and runtime options belong to Transport Providers. */

import type { NACPMessage } from '../NACP/types.ts'
export type { NACPMessage }   // re-exported so NACT-internal modules import message types from one place

export interface TransportSpec<TType extends string = string, TProvider = unknown> {
  type: TType
  provider: TProvider
  nact?: { chunkSize?: number }
}

export type TransportRole = 'server' | 'client' | 'custom'

export interface TransportProvider<TType extends string = string, TOptions = unknown> {
  readonly type: TType
  readonly role: TransportRole
  readonly defaultChunkSize: number
}

export interface TransportChannel extends AsyncIterable<Uint8Array> {
  send(chunks: readonly Uint8Array[]): void | Promise<void>
  onReceive(handler: (bytes: Uint8Array) => void): () => void
  onClose(handler: () => void): () => void
  onError(handler: (reason: unknown) => void): () => void
  close(): void | Promise<void>
  terminate?(): void | Promise<void>
}

export interface ServerTransportProvider<TType extends string = string, TOptions = unknown>
  extends TransportProvider<TType, TOptions> {
  readonly role: 'server'
  listen(options: TOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle>
}

export interface ClientTransportProvider<TType extends string = string, TOptions = unknown>
  extends TransportProvider<TType, TOptions> {
  readonly role: 'client'
  dial(options: TOptions): Promise<TransportChannel>
}

export interface CustomTransportSink {
  send(chunks: readonly Uint8Array[]): void | Promise<void>
  close(): void | Promise<void>
  terminate?(): void | Promise<void>
}

export interface CustomTransportEndpoint {
  readonly peerId: NACTPeerId
  receive(bytes: Uint8Array): void
  closed(): void
  failed(reason: unknown): void
}

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

/** Handle returned by a Server Provider. */
export interface ServerHandle { close(): Promise<void> }
