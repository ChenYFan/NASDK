/**
 * NACAB — Nyirusu Application Control Ability Bus.
 *
 * Fully self-contained: no NACEB Controller inheritance. AbilityHandler is a stateless
 * async function with `this` = AbilityInstance. Each invoke follows the full state machine
 * (pending → running → done/failure) and emits all transition events — faithfully, without
 * judging which ones are "meaningful".
 *
 * One registry, one lookup, one registration path. Whether an ability was registered by a user or by the host
 * App on its own behalf, it lands in the same table and runs down the same path. NACAB has no reserved names
 * and no notion of a "builtin".
 *
 * ── TWO EVENT SURFACES, same shape as NACEB ────────────────────────────────────────────────────────────
 *   T events  `nacab:ability:{state}:{before|after}:{id}`   payload undefined, instance rides as thisArg
 *   runtime   `nacab:runtime:{level}:{id}`                  payload {layer,id,msg?,opt?}, no thisArg
 *
 * The T-event layer segment is `ability`, not `task`: NACEB's three layers (event/pipeline/task) are its own
 * concepts, and the only thing NACAB runs is an ability. `AbilityInstance`, `listAbility()` and this segment
 * all say the same word on purpose.
 *
 * runtime has three levels here (error/warning/log) against NACEB's four — see RuntimeLevel in ./types.ts for
 * why `message` cannot exist on an ability.
 */

import { EventBus, readonlyView } from '../EventBus.ts'
import type { ReadonlyBus } from '../EventBus.ts'
import type { AbilityProcessorHandler } from '../NApp/types.ts'
import { AbilityHandler, AbilityInstance } from './types.ts'
import type { Ability, RuntimeEmit } from './types.ts'
import { nacabInbound } from './errors.ts'
import { NACPAdaptor } from './NACPAdaptor.ts'

/** The T-event layer segment. One constant so the emitter and any doc/test agree on the spelling. */
const LAYER = 'ability'

export class NACAB {
  private handlers = new Map<string, AbilityHandler>()
  readonly eventBus = new EventBus()
  private _nacpAdaptor: NACPAdaptor | null = null
  /** Runtime narration emitter — set up in the constructor, same wiring as NACEB's `_emit`. */
  private _emit: RuntimeEmit

  constructor(opts?: { handlers?: AbilityHandler[] }) {
    this._emit = (level, id, payload) => this.eventBus.emit(`nacab:runtime:${level}:${id}`, payload)
    this.eventBus.onError = (key, err) =>
      this._emit('error', 'bus', {
        layer: 'bus', id: 'bus',
        msg: `observer error @${key}: ${(err as any)?.message ?? err}`,
        opt: { key, error: err },
      })
    for (const h of opts?.handlers ?? []) this.registerHandler(h)
  }

  get eventBusObs(): ReadonlyBus { return this.eventBus.readonly }

  get nacpAdaptor(): NACPAdaptor {
    return this._nacpAdaptor ??= new NACPAdaptor(this)
  }

  /**
   * Register an ability. `execute` receives the payload directly and is typically a closure over whatever the
   * registrar owns — that is how the host App registers its own abilities without NACAB learning anything
   * about NApp or NACP.
   *
   * There is exactly ONE registration path and ONE table. NACAB has no reserved names, no privileged tier,
   * and no notion of a "builtin": an ability the App registered for itself is indistinguishable from one a
   * user registered, which is the point. Later registration of the same name wins, as with any map.
   */
  register(item: AbilityProcessorHandler): void {
    const { name, description, execute } = item
    this.handlers.set(name, new class extends AbilityHandler {
      readonly name = name
      readonly description = description
      async execute(this: AbilityInstance) { return execute(this.input) }
    }())
  }

  /** Register a full AbilityHandler subclass — `this` inside execute() is the AbilityInstance, so a handler
   *  can read input/state. Same single table as register(). */
  registerHandler(h: AbilityHandler): void {
    this.handlers.set(h.name, h)
  }

  /** Declaration items — one table, so nothing to merge. Named `listAbility` to match the NASDK-wide rule that
   *  a method returning "all of X" is `listX` (NACEB.listEventAlias, NACT.listPeerId, NApp.listConnectedApp). */
  listAbility(): Ability[] {
    return [...this.handlers.values()].map(h => ({ name: h.name, description: h.description }))
  }

  /**
   * Run an ability to completion. One invocation = one AbilityInstance, alive only for this call: an ability is
   * one-shot and `invoke` hands the result straight back, so there is deliberately NO id→instance table and no
   * lookup method. Anything that wants to watch an invocation subscribes to the bus, where every transition
   * already carries `readonlyView(t)`.
   *
   * (There used to be such a table. It had no removal path, so every call leaked a row for the lifetime of the
   * process, and nothing ever read it.)
   */
  async invoke(name: string, input: unknown): Promise<unknown> {
    const h = this.handlers.get(name)
    if (!h) {
      // Narrated as a runtime error before throwing: a rejected invoke never reaches the T-event surface (no
      // instance exists yet), so this channel is the only place an observer can see it happened at all.
      const err = nacabInbound('unknown-ability', `no ability handler registered for '${name}'`)
      this._emit('error', name, { layer: LAYER, id: name, msg: err.message, opt: { name, code: err.code } })
      throw err
    }

    const t = new AbilityInstance(name, input)
    t._bus = this.eventBus
    this._emit('log', t.id, { layer: LAYER, id: t.id, msg: `invoke '${name}'`, opt: { name } })

    // pending → running（before + after 忠实上报）
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
        msg: `ability '${name}' threw: ${(err as any)?.message ?? err}`,
        opt: { name, error: err },
      })
      // Rethrow the ORIGINAL error, not a message string: a caller must still be able to read `.stack`, test
      // `instanceof NASDKError`, or reach a cause chain. `t.error` holds the same object for observers.
      throw err
    }
  }

  /** One state change = before-event → status write → after-event, the same order NACEB's THookHandler uses.
   *  NACAB has no hooks, so this is the emit halves only — which is exactly why it collapses to four lines. */
  private transition(t: AbilityInstance, to: AbilityInstance['status']) {
    this.eventBus.emit(`nacab:${LAYER}:${to}:before:${t.id}`, undefined, readonlyView(t))
    t.status = to
    this.eventBus.emit(`nacab:${LAYER}:${to}:after:${t.id}`, undefined, readonlyView(t))
  }
}
