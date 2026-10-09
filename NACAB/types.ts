import { uid } from '../utils/id.ts'
import type { EventBus } from '../EventBus.ts'
// Shared with NACEB, hence defined at the NASDK root.
import type { RuntimePayload, RuntimeEmitFor } from '../types.ts'

export type AbilityStatus = 'pending' | 'running' | 'done' | 'failure'

// error/warning/log only: an ability produces no process output, so no message level.
export type RuntimeLevel = 'error' | 'warning' | 'log'
export type { RuntimePayload }
export type RuntimeEmit = RuntimeEmitFor<RuntimeLevel>

export type { Ability } from '../types.ts'

export abstract class AbilityHandler<R = unknown> {
  abstract readonly name: string
  abstract readonly description: string
  abstract execute(this: AbilityInstance): Promise<R>
}

export class AbilityInstance {
  readonly id!: string
  readonly input!: unknown
  // Reference frozen, contents writable.
  readonly state!: Record<string, any>

  status: AbilityStatus = 'pending'
  result?: unknown
  error?: unknown

  _bus!: EventBus

  constructor(handlerName: string, input: unknown) {
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', uid('ability'))
    ro('input', input)
    ro('state', {})
  }
}
