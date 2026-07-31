/**
 * NACAB types & contracts.
 *
 * AbilityHandler: stateless async function, execute() `this` = AbilityInstance.
 * AbilityInstance: lightweight invocation record (pending → running → done/failure).
 * No hooks, no veto, no pause, no pipeline — pure Req-Res with EventBus observation.
 */

import { uid } from '../utils/id.ts'
import type { EventBus } from '../EventBus.ts'

export type AbilityStatus = 'pending' | 'running' | 'done' | 'failure'

/** NACP Ability declaration item. */
export interface Ability { name: string; description: string }

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
 * Created synchronously by Nacab.invoke, runs pending → running → done/failure within the call.
 */
export class AbilityInstance {
  readonly id!: string
  readonly input!: unknown
  /** 本次执行内的临时键值。引用冻结、内容可写。与 NACEB TaskInstance.state 同构。 */
  readonly state!: Record<string, any>

  status: AbilityStatus = 'pending'
  result?: unknown
  error?: unknown

  // injected by Nacab
  _bus!: EventBus

  constructor(handlerName: string, input: unknown) {
    const ro = (k: string, v: unknown) => Object.defineProperty(this, k, { value: v, writable: false, enumerable: true })
    ro('id', uid('ability'))
    ro('input', input)
    ro('state', {})
  }

  consume(): unknown {
    return this.status === 'done' ? this.result
      : this.status === 'failure' ? { error: this.error }
        : undefined
  }
}
