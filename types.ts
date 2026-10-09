// Shared root types, imported by every layer.

// `code` is internal only; wire-level verdicts travel via whyNotOk, detail in the payload.

export type NASDKErrorPhase = 'inbound' | 'internal' | 'outbound'
export type NASDKLayer = 'NACEB' | 'NACAB' | 'NACP' | 'NACT' | 'NApp'

export class NASDKError extends Error {
  readonly layer: NASDKLayer
  readonly phase: NASDKErrorPhase
  readonly code: string
  constructor(layer: NASDKLayer, phase: NASDKErrorPhase, code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = `${layer}Error`
    this.layer = layer
    this.phase = phase
    this.code = code
  }
}

export function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

export interface Event   { name: string; description: string }
export interface Ability { name: string; description: string }
export type EventList     = Event[]
export type AbilitiesList = Ability[]

export interface Declaration { events: EventList; abilities: AbilitiesList }

export interface ProcessorSpec {
  target: string     // ability/event name (already split from the full name)
  payload: any       // opaque business load
  reqId: string      // NACP pairing anchor (request.id); the processor body never sees it
}

export interface ProcessorHooks {
  onResponse: (result: any, isOk: boolean, whyNotOk?: string) => void   // terminal → response
  onProcess: (chunk: any) => void                                       // process stream → notify
}

export type ProcessorSignalSpec =
  | { signalId: string; reqId: string; kind: 'normal'; payload: unknown }
  | { signalId: string; reqId: string; kind: 'pause' | 'resume' | 'abort' }

export interface Processor {
  list(): { name: string; description: string }[]
  // Return value is the processor's internal id; NACP ignores it (two-layer id isolation).
  push(spec: ProcessorSpec, hooks: ProcessorHooks): string | void
}

export interface EventProcessor extends Processor {
  signal(spec: ProcessorSignalSpec): Promise<void>
}

// NApp registers its own NApp.* abilities here at assembly time.
export interface AbilityProcessor extends Processor {
  register(item: import('./NApp/types.ts').AbilityProcessorHandler): void
}

// Runtime observation events (`naceb:runtime:{level}:{id}` etc.); NOT the T-event surface.
export type RuntimeLevelAll = 'error' | 'warning' | 'log' | 'message' | 'signal'

export interface RuntimePayload {
  layer: string
  id: string
  msg?: string
  opt?: Record<string, unknown>
}

export type RuntimeEmitFor<L extends RuntimeLevelAll> = (level: L, id: string, payload: RuntimePayload) => void
