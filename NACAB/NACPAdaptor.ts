/**
 * NACAB → NACP adaptor. Satisfies the NASDK `Processor` contract by wrapping this NACAB instance.
 */

import type { Processor, ProcessorSpec, ProcessorHooks } from '../types.ts'
import { NASDKError } from '../types.ts'
import type { Nacab } from './NACAB.ts'

function whyNotOk(err: any): string {
  if (err instanceof NASDKError) return `${err.code}: ${err.message}`
  return err?.message ?? String(err)
}

export class NACPAdaptor implements Processor {
  private nacab: Nacab
  constructor(nacab: Nacab) { this.nacab = nacab }

  list() { return this.nacab.getAllAbilities() }

  push(spec: ProcessorSpec, hooks: ProcessorHooks): void {
    this.nacab.invoke(spec.target, spec.payload).then(
      result => hooks.onResponse(result, true),
      err => hooks.onResponse(undefined, false, whyNotOk(err)),
    )
  }
}
