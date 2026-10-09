import type { NACPMessage } from '../NACP/types.ts'
export type { NACPMessage }

export interface TransportSpec<TType extends string = string, TProvider = unknown> {
  type: TType
  provider: TProvider
  nact?: { chunkSize?: number }
}

export type ProviderRole = 'server' | 'client'

export interface ProviderAdaptor<TType extends string = string> {
  readonly type: TType
  readonly role: ProviderRole
  readonly defaultChunkSize: number
}

// Decoded payloads may alias received bytes; Providers must not reuse or mutate them.
export interface Channel {
  // Completion confirms local acceptance; later transport failures go through onError.
  send(frame: readonly Uint8Array[]): void | Promise<void>
  onReceive(handler: (frame: readonly Uint8Array[]) => void): () => void
  onClose(handler: () => void): () => void
  onError(handler: (reason: unknown) => void): () => void
  close(): void | Promise<void>
  terminate?(): void | Promise<void>
}

export interface ServerProvider<TType extends string = string, TOptions = unknown>
  extends ProviderAdaptor<TType> {
  readonly role: 'server'
  listen(options: TOptions, accept: (channel: Channel) => void): Promise<ServerHandle>
}

export interface ClientProvider<TType extends string = string, TOptions = unknown>
  extends ProviderAdaptor<TType> {
  readonly role: 'client'
  dial(options: TOptions): Promise<Channel>
}

export type NACTPeerId = string

// terminate is optional: carriers without force-drop degrade to close().
export interface Peer {
  id: NACTPeerId
  send(msg: NACPMessage): Promise<void>
  close(): void
  terminate?(): void
}

export interface Codec {
  encode(msg: NACPMessage): Uint8Array
  decode(data: Uint8Array): NACPMessage
}

export interface ServerHandle { close(): Promise<void> }
