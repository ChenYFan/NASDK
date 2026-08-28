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
 * Runtime observation events — `nacab:runtime:{level}:{id}`, levels error/warning/log only (an ability
 * produces no process output, so there is no `message` level).
 */
export type RuntimeLevel = 'error' | 'warning' | 'log'
export type { RuntimePayload }
/** Set up by NACAB at construction: emits `nacab:runtime:{level}:{id}` on its own EventBus. */
export type RuntimeEmit = RuntimeEmitFor<RuntimeLevel>

export type { Ability } from '../types.ts'

/** Stateless ability handler; execute() `this` is AbilityInstance. */
export abstract class AbilityHandler<R = unknown> {
  abstract readonly name: string
  abstract readonly description: string
  abstract execute(this: AbilityInstance): Promise<R>
}

/** Lightweight per-invocation record; not filed anywhere (invoke returns the result directly). */
export class AbilityInstance {
  readonly id!: string
  readonly input!: unknown
  /** Per-invocation scratch state. Reference frozen, contents writable. */
  readonly state!: Record<string, any>

  status: AbilityStatus = 'pending'
  result?: unknown
  /** The thrown value itself, not its message. */
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
