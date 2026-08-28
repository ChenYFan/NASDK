/**
 * NASDK root shared types — error Base, Declaration, Processor contract, runtime observation shapes.
 * Placed at the root so every layer imports from one place.
 */

// ============================================================
// Errors — one Base across all NASDK layers: layer + phase + code + message.
//   ⚠️ `code` is INTERNAL and never reaches the wire; whyNotOk carries protocol-level verdicts only,
//   underlying detail travels in the response payload (opaque to NACP).
// ============================================================

export type NASDKErrorPhase = 'inbound' | 'internal' | 'outbound'
export type NASDKLayer = 'NACEB' | 'NACAB' | 'NACP' | 'NACT' | 'NApp'

export class NASDKError extends Error {
  readonly layer: NASDKLayer
  readonly phase: NASDKErrorPhase
  readonly code: string
  constructor(layer: NASDKLayer, phase: NASDKErrorPhase, code: string, message: string) {
    super(message)
    this.name = `${layer}Error`
    this.layer = layer
    this.phase = phase
    this.code = code
  }
}

/** Human-readable detail of anything thrown, for a Processor adaptor to put in the response PAYLOAD.
 *  Reads only the message — the adaptor states the verdict itself in whyNotOk. */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

// ============================================================
// Declaration — "here is what I can do". One definition at the root; NACP carries it in the register
// handshake, NACEB lists events, NACAB lists abilities.
// ============================================================

export interface Event   { name: string; description: string }
export interface Ability { name: string; description: string }
export type EventList     = Event[]
export type AbilitiesList = Ability[]

/** Carried in register's payload and by `NApp.introduce`. */
export interface Declaration { events: EventList; abilities: AbilitiesList }

// ============================================================
// Processor — the contract NACP's binding layer depends on. NACP knows only THIS, not NACAB/NACEB.
// ============================================================

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

/**
 * The contract NACP's binding layer depends on, in its minimal form: a Processor can be READ (list) and
 * PUSHED (push). Nothing else is universal across kinds.
 */
export interface Processor {
  // Declaration items (name+description) for register. event → EventList, ability → AbilitiesList.
  list(): { name: string; description: string }[]
  // Push a request in + bind the two output callbacks. May return an internal id (e.g. NACEB eventId);
  // NACP does not take this return value (two-layer id isolation).
  push(spec: ProcessorSpec, hooks: ProcessorHooks): string | void
}

/** The event-side contract; adds signal() to Processor. */
export interface EventProcessor extends Processor {
  signal(spec: ProcessorSignalSpec): Promise<void>
}

/** The ability side additionally accepts registration from outside via register(item); NApp uses it at
 *  assembly time for its own NApp.* abilities. Item shape: NApp/types.ts AbilityProcessorHandler. */
export interface AbilityProcessor extends Processor {
  register(item: import('./NApp/types.ts').AbilityProcessorHandler): void
}

// ============================================================
// Runtime observation — a Processor's internal narration channel.
//     naceb:runtime:{level}:{id}      levels: error | warning | log | message | signal
//     nacab:runtime:{level}:{id}      levels: error | warning | log (abilities produce no `message`)
//   Payload shape shared here; each layer names the level subset it can emit. This is the observation
//   channel, NOT the T-event surface (T events carry the instance as thisArg, no payload).
// ============================================================

/** Every level any Processor may narrate at; a layer narrows this to what it can emit. */
export type RuntimeLevelAll = 'error' | 'warning' | 'log' | 'message' | 'signal'

/** Payload of a `*:runtime:{level}:{id}` event; level-specific detail rides in `opt`. */
export interface RuntimePayload {
  layer: string
  id: string
  msg?: string
  opt?: Record<string, unknown>
}

/** A layer's own runtime emitter, parameterised by the level subset that layer supports. */
export type RuntimeEmitFor<L extends RuntimeLevelAll> = (level: L, id: string, payload: RuntimePayload) => void
