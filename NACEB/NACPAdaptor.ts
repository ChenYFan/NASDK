/**
 * NACEB → NACP adaptor. Satisfies the NASDK `Processor` contract by wrapping this NACEB instance, so
 * NACP's binding layer can bind it (`bindProcessor('event', naceb.nacpAdaptor)`) without NACP ever
 * knowing NACEB. NACP vocabulary (target/reqId/hooks) sticks only here; the NACEB body stays pure.
 *
 * Event is stateful: push → (process notifies)* → terminal response. The adaptor drives NACEB via its
 * existing public surface only (pushEvent / getEvent / consumeEvent / obs / listEventAlias) — NACEB
 * internals unchanged. Uses the idle window (NOT bypassIdle): push → attach hooks/listen → start, so
 * hooks are in place before the first transition — same zero-race pattern as builtin $wait4SubEvent.
 *
 * Two-layer id isolation: NACP gives only reqId (opaque handle, unused here beyond being NACP's own
 * anchor); the NACEB eventId is minted internally and never leaks back to NACP.
 */

import type { EventProcessor, ProcessorSignalSpec, ProcessorSpec, ProcessorHooks } from '../types.ts'
import { errorDetail } from '../types.ts'
import type { ReadonlyBus } from '../EventBus.ts'
import type { NACEB } from './NACEB.ts'

/**
 * Two kinds of failure, and the adaptor only ever reports its OWN kind.
 *
 * `whyNotOk` is a PROTOCOL field: it goes on the wire in ResponseMeta, so the peer reads it. It must therefore
 * say only what any Processor could say — "the push was rejected", "the run failed" — never what NACEB
 * specifically went wrong. Words like pipeline / task / eventAlias / beforeT are NACEB's own vocabulary, and a
 * peer that reads them is being forced to know which processor we happen to run. Nor may an internal machine
 * code (NASDKError.code) travel: it is not part of the protocol's error vocabulary.
 *
 * NACEB's own detail is not discarded — it rides the response PAYLOAD, which is opaque business data as far as
 * NACP is concerned. So the peer gets a stable protocol-level verdict plus, if it wants, the full detail.
 */
const REJECTED = 'processor-rejected'   // push refused the call outright (nothing started)
const FAILED   = 'processor-failed'     // the call ran and ended in failure

export class NACPAdaptor implements EventProcessor {
  private naceb: NACEB
  private obs: ReadonlyBus
  private reqEvents = new Map<string, string>()
  constructor(naceb: NACEB) { this.naceb = naceb; this.obs = naceb.eventBusObs }

  /** Declaration items — delegate to listEventAlias(). */
  list() { return this.naceb.listEventAlias() }

  /** push (idle) → listen process → attach terminal hooks → start. Returns the eventId (NACP won't take it). */
  push(spec: ProcessorSpec, hooks: ProcessorHooks): string {
    let eventId: string
    try {
      // eventName = target (resolved to pipeline via eventAlias, or self-carried); stops in idle (no bypassIdle).
      eventId = this.naceb.pushEvent({ name: spec.target, payload: spec.payload })
    } catch (err: any) {
      // Push-time rejection → terminal failure, don't hang the caller. The adaptor does NOT read why NACEB
      // refused (it would have to understand NACEB's codes to do so); it states the protocol-level fact and
      // hands the raw reason down the payload.
      hooks.onResponse({ error: errorDetail(err) }, false, REJECTED)
      return ''
    }
    // process stream: keep the subscription id so we can off it on terminal. (runtime message event; chunk rides opt)
    const processKey = `naceb:runtime:message:${eventId}`
    const processSub = this.obs.listen(processKey, (m: any) => hooks.onProcess(m?.opt?.chunk))
    // terminal: attach BEFORE start so the done/failure signal can't be missed. consume takes the final result.
    const ev = this.naceb.getEvent(eventId)!
    ev.afterTDone(() => {
      this.reqEvents.delete(spec.reqId)
      this.obs.off(processSub)
      hooks.onResponse(this.naceb.consumeEvent(eventId), true)
    })
    ev.afterTFailure(() => {
      this.reqEvents.delete(spec.reqId)
      this.obs.off(processSub)
      // The final object goes through untouched — whatever NACEB put in it is business/implementation detail
      // for the payload. The adaptor does not inspect it to build whyNotOk.
      hooks.onResponse(this.naceb.consumeEvent(eventId), false, FAILED)
    })
    this.reqEvents.set(spec.reqId, eventId)
    ev.start()
    return eventId
  }

  async signal(spec: ProcessorSignalSpec): Promise<void> {
    const eventId = this.reqEvents.get(spec.reqId)
    const ev = eventId ? this.naceb.getEvent(eventId) : null
    if (!ev) {
      this.reqEvents.delete(spec.reqId)
      throw new Error(`no active event for reqId '${spec.reqId}'`)
    }
    this.naceb.eventBus.emit(`naceb:runtime:signal:${eventId}`, {
      layer: 'event', id: eventId, opt: { signalId: spec.signalId, reqId: spec.reqId, kind: spec.kind,
        ...(spec.kind === 'normal' && { payload: spec.payload }) },
    })
    switch (spec.kind) {
      case 'normal': return ev.normalSIG({ signalId: spec.signalId, kind: 'normal', payload: spec.payload })
      case 'pause': if (!await ev.pause()) throw new Error(`event '${eventId}' could not pause`); return
      case 'resume': if (!await ev.resume()) throw new Error(`event '${eventId}' could not resume`); return
      case 'abort': return ev.abort()
    }
  }
}
