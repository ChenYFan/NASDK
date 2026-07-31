/**
 * NACAB — Nyirusu Application Control Ability Bus.
 *
 * Fully self-contained: no NACEB Controller inheritance. AbilityHandler is a stateless
 * async function with `this` = AbilityInstance. Each invoke follows the full state machine
 * (pending → running → done/failure) and emits all transition events — faithfully, without
 * judging which ones are "meaningful".
 */

import { EventBus, readonlyView } from '../EventBus.ts'
import type { ReadonlyBus } from '../EventBus.ts'
import { AbilityHandler, AbilityInstance } from './types.ts'
import type { Ability } from './types.ts'
import { nacabInbound } from './errors.ts'
import { NACPAdaptor } from './NACPAdaptor.ts'

export class Nacab {
  private handlers = new Map<string, AbilityHandler>()
  private byId = new Map<string, AbilityInstance>()
  readonly eventBus = new EventBus()
  private _nacpAdaptor: NACPAdaptor | null = null

  constructor(opts?: { handlers?: AbilityHandler[] }) {
    this.eventBus.onError = (key, err) =>
      this.eventBus.emit(`nacab:runtime:error:bus`, { layer: 'bus', id: 'bus', msg: `observer error @${key}: ${(err as any)?.message ?? err}`, opt: { key, error: err } })
    for (const h of opts?.handlers ?? []) this.register(h)
  }

  get eventBusObs(): ReadonlyBus { return this.eventBus.readonly }

  get nacpAdaptor(): NACPAdaptor {
    return this._nacpAdaptor ??= new NACPAdaptor(this)
  }

  register(h: AbilityHandler): void { this.handlers.set(h.name, h) }

  getAllAbilities(): Ability[] {
    return [...this.handlers.values()].map(h => ({ name: h.name, description: h.description }))
  }

  getTask(id: string): AbilityInstance | null { return this.byId.get(id) ?? null }

  async invoke(name: string, input: unknown): Promise<unknown> {
    const h = this.handlers.get(name)
    if (!h) throw nacabInbound('unknown-ability', `no ability handler registered for '${name}'`)

    const t = new AbilityInstance(name, input)
    t._bus = this.eventBus
    this.byId.set(t.id, t)

    // pending → running（before + after 忠实上报）
    t.status = 'pending'
    this.eventBus.emit(`nacab:task:running:before:${t.id}`, undefined, readonlyView(t))
    t.status = 'running'
    this.eventBus.emit(`nacab:task:running:after:${t.id}`, undefined, readonlyView(t))

    try {
      const result = await h.execute.call(t)
      t.result = result
      this.eventBus.emit(`nacab:task:done:before:${t.id}`, undefined, readonlyView(t))
      t.status = 'done'
      this.eventBus.emit(`nacab:task:done:after:${t.id}`, undefined, readonlyView(t))
      return result
    } catch (err) {
      t.error = (err as any)?.message ?? String(err)
      this.eventBus.emit(`nacab:task:failure:before:${t.id}`, undefined, readonlyView(t))
      t.status = 'failure'
      this.eventBus.emit(`nacab:task:failure:after:${t.id}`, undefined, readonlyView(t))
      throw t.error
    }
  }
}
