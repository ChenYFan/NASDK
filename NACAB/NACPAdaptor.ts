/**
 * NACAB → NACP adaptor. Satisfies the NASDK `Processor` contract by wrapping this NACAB instance.
 */

import type { AbilityProcessor, ProcessorSpec, ProcessorHooks } from '../types.ts'
import { errorDetail } from '../types.ts'
import type { AbilityProcessorHandler } from '../NApp/types.ts'
import type { NACAB } from './NACAB.ts'

/**
 * Same split as the NACEB adaptor: `whyNotOk` is a protocol field, so it states only what any Processor could
 * state — the call failed. NACAB's own vocabulary (unknown-ability, ability handler, its error codes) stays
 * out of it; the detail rides the response payload, opaque to NACP.
 *
 * Ability is one-shot, so there is only one failure verdict — unlike NACEB there is no "rejected before it
 * started" vs "ran and failed" distinction to make.
 */
const FAILED = 'processor-failed'

export class NACPAdaptor implements AbilityProcessor {
  private nacab: NACAB
  constructor(nacab: NACAB) { this.nacab = nacab }

  list() { return this.nacab.listAbility() }

  push(spec: ProcessorSpec, hooks: ProcessorHooks): void {
    this.nacab.invoke(spec.target, spec.payload).then(
      result => hooks.onResponse(result, true),
      // The adaptor does not read WHY nacab refused or failed — it reports the fact and passes detail down.
      err => hooks.onResponse({ error: errorDetail(err) }, false, FAILED),
    )
  }

  /** The contract's registration port, forwarded verbatim. The host App uses it at assembly time to register
   *  the abilities it provides on its own behalf; a user calls the same port for theirs. NACAB cannot tell the
   *  two apart, and there is nothing here for it to special-case. */
  register(item: AbilityProcessorHandler): void { this.nacab.register(item) }
}
