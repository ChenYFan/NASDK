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
//   code is a stable kebab-case machine code for LOCAL handling — matching in a catch, logging, tests.
//   message is human-readable detail.
//
//   ⚠️ `code` is INTERNAL and must never reach the wire. A processor's codes are its own vocabulary
//   (NACEB has unresolved-pipeline, NACAB has unknown-ability); putting them in ResponseMeta.whyNotOk would
//   force the peer to understand which processor we happen to run. whyNotOk carries protocol-level verdicts
//   only; the underlying detail travels in the response payload, which is opaque to NACP.
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

/**
 * Pull human-readable detail out of anything thrown, for a Processor adaptor to put in the response PAYLOAD.
 *
 * Deliberately does NOT read `code`, and deliberately does not classify: an adaptor reporting a failure should
 * not have to understand its own engine's error taxonomy. It states the protocol-level verdict in `whyNotOk`
 * and passes the detail through here.
 */
export function errorDetail(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

// ============================================================
// Declaration — the shape every layer names when it says "here is what I can do".
//   An Event and an Ability are the SAME shape ({name, description}); the two names exist because the two
//   kinds are different things to a reader, not because the records differ. Kept HERE, at the root, because
//   three layers all need them and none of the three owns the concept:
//     NACP  builds a Declaration into the register handshake and reads one back
//     NACEB lists its eventAlias entries as Events
//     NACAB lists its registered abilities as Abilities
//   They used to be declared once per layer — structurally identical copies that a cross-layer signature had
//   to pick between, and that made a root barrel collide on the names. One definition removes both problems.
// ============================================================

export interface Event   { name: string; description: string }
export interface Ability { name: string; description: string }
export type EventList     = Event[]
export type AbilitiesList = Ability[]

/** What an App answers when asked what it can do — carried in register's payload and by `NApp.introduce`.
 *  "No abilities" is simply an empty list; there is no marker for it. */
export interface Declaration { events: EventList; abilities: AbilitiesList }

// ============================================================
// Processor — the contract NACP's binding layer depends on. NACP knows only THIS, not NACAB/NACEB.
//   A kind processor (event/ability) satisfies it via a `nacpAdaptor` sub-part; the processor body stays
//   pure/generic and never touches NACP vocabulary.
//
//   Surface: list + push for both kinds, plus register on the ability side. push carries the two output
//   callbacks (ProcessorHooks: onResponse / onProcess). Supply your own processor instead of NACAB/NACEB and
//   you implement these yourself — in particular an ability processor MUST accept register, because the App
//   registers the abilities it provides on its own behalf through that port at assembly time.
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

/**
 * The event side adds NOTHING to the contract — it is `Processor` exactly. This alias exists so both kinds can
 * be NAMED symmetrically (`EventProcessor` / `AbilityProcessor`) when documenting or annotating a binding,
 * instead of one side reading as "the generic one". Anything genuinely universal to both kinds belongs on
 * `Processor` above, not here.
 *
 * There is deliberately no `register` on this side: an event's implementation is not a single callable (NACEB
 * resolves an event name to a pipeline of tasks), so a generic `register(item)` would have nothing to mean.
 */
export interface EventProcessor extends Processor {
  signal(spec: ProcessorSignalSpec): Promise<void>
}

/**
 * The ability side additionally accepts REGISTRATION from outside: `register` is an ordinary capability port,
 * the same one a user calls to add an ability. NApp uses it at assembly time to register the abilities it
 * provides on its own behalf (`NApp.introduce` and friends) — so those need no sideband, no injection hook, no
 * reserved prefix, and no second table inside the processor. The processor cannot tell NApp's registration
 * from anyone else's, which is exactly the property being bought.
 *
 * The item shape lives in NApp/types.ts (`AbilityProcessorHandler`), because the App is who registers.
 */
export interface AbilityProcessor extends Processor {
  register(item: import('./NApp/types.ts').AbilityProcessorHandler): void
}

// ============================================================
// Runtime observation — the shape a Processor uses for its own internal narration channel.
//   Both built-in Processors expose one, under their own prefix and with the same payload shape:
//
//     naceb:runtime:{level}:{id}      levels: error | warning | log | message
//     nacab:runtime:{level}:{id}      levels: error | warning | log
//
//   The PAYLOAD shape is shared, which is why it lives here. The LEVEL SET is not: `message` means
//   "formal process output from a running task", and an ability produces none by definition (the Processor
//   contract says onProcess is never called for `ability`). So each layer names the subset it can actually
//   emit, and NACAB having no `message` is a fact about abilities rather than an omission.
//
//   This is the observation channel, NOT the T-event surface. T events (`naceb:{layer}:{state}:{phase}:{id}`,
//   `nacab:ability:{state}:{phase}:{id}`) carry an undefined payload with the instance riding as `thisArg`;
//   runtime events carry this payload and no thisArg.
// ============================================================

/** Every level any Processor may narrate at. A layer narrows this to what it can emit. */
export type RuntimeLevelAll = 'error' | 'warning' | 'log' | 'message' | 'signal'

/** Payload of a `*:runtime:{level}:{id}` event. `layer`/`id`/`msg` are the stable fields; anything
 *  level-specific (a transition's from/to, an error's phase/state, a message's chunk) rides in `opt`, so an
 *  observer that does not care never touches it. */
export interface RuntimePayload {
  layer: string
  id: string
  msg?: string
  opt?: Record<string, unknown>
}

/** A layer's own runtime emitter, parameterised by the level subset that layer supports. */
export type RuntimeEmitFor<L extends RuntimeLevelAll> = (level: L, id: string, payload: RuntimePayload) => void
