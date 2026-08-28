/**
 * NACAB → NACP adaptor. Satisfies the NASDK `Processor` contract by wrapping this NACAB instance.
 */

import type { AbilityProcessor, ProcessorSpec, ProcessorHooks } from '../types.ts'
import { errorDetail } from '../types.ts'
import type { AbilityProcessorHandler } from '../NApp/types.ts'
import type { NACAB } from './NACAB.ts'

/**
 * whyNotOk is a protocol field: it states only the fact of failure; NACAB's own vocabulary rides the
 * response payload. Ability is one-shot, so there is only one failure verdict.
 */
const FAILED = 'processor-failed'

export class NACPAdaptor implements AbilityProcessor {
  private nacab: NACAB
  constructor(nacab: NACAB) { this.nacab = nacab }

  list() { return this.nacab.listAbility() }

  push(spec: ProcessorSpec, hooks: ProcessorHooks): void {
    this.nacab.invoke(spec.target, spec.payload).then(
      result => hooks.onResponse(result, true),
      err => hooks.onResponse({ error: errorDetail(err) }, false, FAILED),
    )
  }

  /** The contract's registration port, forwarded verbatim. */
  register(item: AbilityProcessorHandler): void { this.nacab.register(item) }
}
