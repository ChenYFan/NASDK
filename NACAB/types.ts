/**
 * NACAB types & contracts.
 *
 * AbilityHandler: stateless async function, execute() `this` = AbilityInstance.
 * AbilityInstance: lightweight invocation record (pending → running → done/failure).
 * No hooks, no veto, no pause, no pipeline — pure Req-Res with EventBus observation.
 */

import { uid } from '../utils/id.ts'
import type { EventBus } from '../EventBus.ts'
// Shared with NACEB, hence defined at the NASDK root. Only the level SUBSET below is NACAB's own.
import type { RuntimePayload, RuntimeEmitFor } from '../types.ts'

export type AbilityStatus = 'pending' | 'running' | 'done' | 'failure'

/**
 * Runtime observation events — NACAB's internal narration channel, `nacab:runtime:{level}:{id}`, structurally
 * identical to NACEB's:
 *   - error   : a runtime error (an observer threw, a handler failed). id = the AbilityInstance id, or 'bus'.
 *   - warning : a runtime warning. id = the AbilityInstance id.
 *   - log     : an internal log line (invoke start, transitions, terminal). id = the AbilityInstance id.
 *
 * There is deliberately NO `message` level, which is the one place the two Processors differ: `message` means
 * formal process output from a running task, and an ability produces none — the Processor contract states that
 * `onProcess` is never called for `ability`. The absent level is a fact about abilities, not an omission.
 *
 * This is the observation channel, NOT the T-event surface: T events (`nacab:ability:{state}:{phase}:{id}`)
 * carry an undefined payload with the instance riding as `thisArg`; these carry the payload and no thisArg.
 */
export type RuntimeLevel = 'error' | 'warning' | 'log'
export type { RuntimePayload }
/** Set up by NACAB at construction: emits `nacab:runtime:{level}:{id}` on its own EventBus. */
export type RuntimeEmit = RuntimeEmitFor<RuntimeLevel>

/** The NACP declaration item (name + description) that `listAbility()` returns. Defined at the NASDK root
 *  (../types.ts) and re-exported here — NACP, NACEB and NACAB all need this one shape. */
export type { Ability } from '../types.ts'

/**
 * Stateless ability handler. execute() `this` is AbilityInstance —
 * access input/status/state through `this`, symmetric with NACEB TaskHandler.
 */
export abstract class AbilityHandler<R = unknown> {
  abstract readonly name: string
  abstract readonly description: string
  abstract execute(this: AbilityInstance): Promise<R>
}

/**
 * AbilityInstance — lightweight per-invocation record.
 * Created synchronously by NACAB.invoke, runs pending → running → done/failure within the call.
 *
 * It is NOT filed anywhere: `invoke` returns the result directly, so there is no id→instance table to consume
 * from either (which is why this class has no `consume()` — NACEB's version of that method exists to take a
 * result AND remove a row, and here there is no row). Observers reach it through the bus, where every
 * transition carries a readonlyView of it.
 */
export class AbilityInstance {
  readonly id!: string
  readonly input!: unknown
  /** 本次执行内的临时键值。引用冻结、内容可写。与 NACEB TaskInstance.state 同构。 */
  readonly state!: Record<string, any>

  status: AbilityStatus = 'pending'
  result?: unknown
  /** The thrown value itself, not its message — a caller rethrown from invoke() needs the real object. */
  error?: unknown

  // injected by NACAB
  _bus!: EventBus

  constructor(handlerName: string, input: unknown) {
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', uid('ability'))
    ro('input', input)
    ro('state', {})
  }
}
