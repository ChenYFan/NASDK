/**
 * NACEB → NACP adaptor. Satisfies the NASDK `Processor` contract by wrapping this NACEB instance, so
 * NACP's binding layer can bind it (`bindProcessor('event', naceb.nacpAdaptor)`) without NACP ever
 * knowing NACEB. NACP vocabulary (target/reqId/hooks) sticks only here; the NACEB body stays pure.
 *
 * Event is stateful: push → (process notifies)* → terminal response. The adaptor drives NACEB via its
 * existing public surface only (pushEvent / getEvent / consumeEvent / obs / getAllEvents) — NACEB
 * internals unchanged. Uses the idle window (NOT bypassIdle): push → attach hooks/listen → start, so
 * hooks are in place before the first transition — same zero-race pattern as builtin $wait4SubEvent.
 *
 * Two-layer id isolation: NACP gives only reqId (opaque handle, unused here beyond being NACP's own
 * anchor); the NACEB eventId is minted internally and never leaks back to NACP.
 */

import type { Processor, ProcessorSpec, ProcessorHooks } from '../types.ts'
import { NASDKError } from '../types.ts'
import type { ReadonlyBus } from '../EventBus.ts'
import type { Naceb } from './NACEB.ts'

/** whyNotOk string: NASDKError carries a machine code → `code: message`; a plain Error → its message. */
function whyNotOk(err: any): string {
  if (err instanceof NASDKError) return `${err.code}: ${err.message}`
  return err?.message ?? String(err)
}

export class NACPAdaptor implements Processor {
  private naceb: Naceb
  private obs: ReadonlyBus
  constructor(naceb: Naceb) { this.naceb = naceb; this.obs = naceb.eventBusObs }

  /** Declaration items — delegate to getAllEvents(). */
  list() { return this.naceb.getAllEvents() }

  /** push (idle) → listen process → attach terminal hooks → start. Returns the eventId (NACP won't take it). */
  push(spec: ProcessorSpec, hooks: ProcessorHooks): string {
    let eventId: string
    try {
      // eventName = target (resolved to pipeline via eventAlias, or self-carried); stops in idle (no bypassIdle).
      eventId = this.naceb.pushEvent({ name: spec.target, payload: spec.payload })
    } catch (err: any) {
      // push-time rejection (unresolved-pipeline / vetoed / unregistered) → terminal failure, don't hang the caller.
      hooks.onResponse(undefined, false, whyNotOk(err))
      return ''
    }
    // process stream: store cb ref so we can off it on terminal. (runtime message event; chunk rides opt)
    const processKey = `naceb:runtime:message:${eventId}`
    const processCb = (m: any) => hooks.onProcess(m?.opt?.chunk)
    this.obs.listen(processKey, processCb)
    // terminal: attach BEFORE start so the done/failure signal can't be missed. consume takes the final result.
    const ev = this.naceb.getEvent(eventId)!
    ev.afterTDone(() => {
      this.obs.off(processCb)
      hooks.onResponse(this.naceb.consumeEvent(eventId), true)
    })
    ev.afterTFailure(() => {
      this.obs.off(processCb)
      const final = this.naceb.consumeEvent(eventId) as any
      hooks.onResponse(final, false, final?.error ?? 'event failure')
    })
    ev.start()
    return eventId
  }
}
