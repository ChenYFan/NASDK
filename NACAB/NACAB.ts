/**
 * NACAB — Nyirusu Application Control Ability Bus. Fully self-contained (no NACEB inheritance).
 * AbilityHandler is a stateless async function with `this` = AbilityInstance; each invoke runs
 * pending → running → done/failure with all transition events emitted.
 *
 * One registry, one lookup, one registration path — no reserved names, no "builtin".
 *
 * Event surfaces: T events `nacab:ability:{state}:{before|after}:{id}` (instance as thisArg) and runtime
 * `nacab:runtime:{level}:{id}` (levels error/warning/log — abilities produce no `message`).
 */

import { EventBus, readonlyView } from '../EventBus.ts'
import type { ReadonlyBus } from '../EventBus.ts'
import type { AbilityProcessorHandler } from '../NApp/types.ts'
import { AbilityHandler, AbilityInstance } from './types.ts'
import type { Ability, RuntimeEmit } from './types.ts'
import { nacabInbound } from './errors.ts'
import { NACPAdaptor } from './NACPAdaptor.ts'

const LAYER = 'ability'

export class NACAB {
  private handlers = new Map<string, AbilityHandler>()
  readonly eventBus = new EventBus()
  private _nacpAdaptor: NACPAdaptor | null = null
  private _emit: RuntimeEmit

  constructor(opts?: { handlers?: AbilityHandler[] }) {
    this._emit = (level, id, payload) => this.eventBus.emit(`nacab:runtime:${level}:${id}`, payload)
    this.eventBus.onError = (key, err) =>
      this._emit('error', 'bus', {
        layer: 'bus', id: 'bus',
        msg: `observer error @${key}: ${(err as any)?.message ?? String(err)}`,
        opt: { key, error: err },
      })
    for (const h of opts?.handlers ?? []) this.registerHandler(h)
  }

  get eventBusObs(): ReadonlyBus { return this.eventBus.readonly }

  get nacpAdaptor(): NACPAdaptor {
    return this._nacpAdaptor ??= new NACPAdaptor(this)
  }

  /** Register an ability; later registration of the same name wins. */
  register(item: AbilityProcessorHandler): void {
    const { name, description, execute } = item
    this.handlers.set(name, new class extends AbilityHandler {
      readonly name = name
      readonly description = description
      async execute(this: AbilityInstance) { return execute(this.input) }
    }())
  }

  registerHandler(h: AbilityHandler): void {
    this.handlers.set(h.name, h)
  }

  listAbility(): Ability[] {
    return [...this.handlers.values()].map(h => ({ name: h.name, description: h.description }))
  }

  /**
   * Run an ability to completion. One invocation = one AbilityInstance, alive only for this call — no
   * id→instance table; observers watch via the bus. Rethrows the ORIGINAL error.
   */
  async invoke(name: string, input: unknown): Promise<unknown> {
    const h = this.handlers.get(name)
    if (!h) {
      // Narrated before throwing: no instance exists yet, so the T-event surface never sees it.
      const err = nacabInbound('unknown-ability', `no ability handler registered for '${name}'`)
      this._emit('error', name, { layer: LAYER, id: name, msg: err.message, opt: { name, code: err.code } })
      throw err
    }

    const t = new AbilityInstance(name, input)
    t._bus = this.eventBus
    this._emit('log', t.id, { layer: LAYER, id: t.id, msg: `invoke '${name}'`, opt: { name } })

    // pending → running
    this.transition(t, 'running')

    try {
      const result = await h.execute.call(t)
      t.result = result
      this.transition(t, 'done')
      this._emit('log', t.id, { layer: LAYER, id: t.id, msg: `done '${name}'`, opt: { name } })
      return result
    } catch (err) {
      t.error = err
      this.transition(t, 'failure')
      this._emit('error', t.id, {
        layer: LAYER, id: t.id,
        msg: `ability '${name}' threw: ${(err as any)?.message ?? String(err)}`,
        opt: { name, error: err },
      })
      throw err
    }
  }

  /** One state change = before-event → status write → after-event. */
  private transition(t: AbilityInstance, to: AbilityInstance['status']) {
    this.eventBus.emit(`nacab:${LAYER}:${to}:before:${t.id}`, undefined, readonlyView(t))
    t.status = to
    this.eventBus.emit(`nacab:${LAYER}:${to}:after:${t.id}`, undefined, readonlyView(t))
  }
}
