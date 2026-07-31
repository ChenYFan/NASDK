/**
 * NASDK root shared types — the error Base and (future) exchange types (NacpMessage etc.).
 * Placed at the NASDK root (alongside EventBus.ts / utils / errors) so every layer imports from
 * one place; layers depend on this pure definition module, not on each other's implementations.
 */

// ============================================================
// Errors — one Base across all NASDK layers.
//   A single error is: layer (which component) + phase (inbound/internal/outbound) + code + message.
//   layer is fixed by each layer's SUBCLASS (NACEB/errors.ts → NACEBError, NACAB/errors.ts → NACABError, …).
//   phase is a constant axis shared by every layer: inbound (a request couldn't be admitted),
//   internal (failure while working inside), outbound (failure emitting outward).
//   code is a stable kebab-case machine code the upper layer (NApp/NACP binding) matches on to translate
//   into response{isOk:false, whyNotOk}; message is human-readable detail.
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

// ============================================================
// Processor — the contract NACP's binding layer depends on. NACP knows only THIS, not NACAB/NACEB.
//   A kind processor (event/ability) satisfies it via a `nacpAdaptor` sub-part; the processor body stays
//   pure/generic and never touches NACP vocabulary. Any object with list + push is a valid Processor.
// ============================================================

export interface ProcessorSpec {
  target: string     // ability/event name (facade-side already split from the full name; adaptor doesn't parse)
  payload: any       // opaque business load
  reqId: string      // NACP pairing anchor (request.id). Adaptor keeps it; the processor body never sees it.
}

export interface ProcessorHooks {
  // terminal: isOk=true is success; failure carries whyNotOk. NACP turns this into a response.
  onResponse: (result: any, isOk: boolean, whyNotOk?: string) => void
  // process stream: NACP turns each chunk into a notify. Ability processors never call this.
  onProcess: (chunk: any) => void
}

export interface Processor {
  // Declaration items (name+description) for register. event → EventList, ability → AbilitiesList.
  list(): { name: string; description: string }[]
  // Push a request in + bind the two output callbacks. May return an internal id (e.g. NACEB eventId);
  // NACP does not take this return value (two-layer id isolation).
  push(spec: ProcessorSpec, hooks: ProcessorHooks): string | void
}
