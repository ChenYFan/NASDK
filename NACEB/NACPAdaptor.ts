// Uses the idle window (NOT bypassIdle): push → attach hooks → start, so hooks exist before
// the first transition. NACEB eventId never leaks back to NACP.

import type { EventProcessor, ProcessorSignalSpec, ProcessorSpec, ProcessorHooks } from '../types.ts'
import { errorDetail } from '../types.ts'
import type { ReadonlyBus } from '../EventBus.ts'
import type { NACEB } from './NACEB.ts'

// `whyNotOk` is a protocol field read by the peer: it states only what any Processor could
// say. NACEB's own vocabulary rides the response payload, never whyNotOk.
const REJECTED = 'processor-rejected'   // push refused the call outright
const FAILED   = 'processor-failed'     // the call ran and ended in failure

export class NACPAdaptor implements EventProcessor {
  private naceb: NACEB
  private obs: ReadonlyBus
  private reqEvents = new Map<string, string>()
  constructor(naceb: NACEB) { this.naceb = naceb; this.obs = naceb.eventBusObs }

  list() { return this.naceb.listEventAlias() }

  // Push (idle) → listen → attach terminal hooks → start.
  push(spec: ProcessorSpec, hooks: ProcessorHooks): string {
    let eventId: string
    try {
      eventId = this.naceb.pushEvent({ name: spec.target, payload: spec.payload })
    } catch (err: any) {
      hooks.onResponse({ error: errorDetail(err) }, false, REJECTED)
      return ''
    }
    const processKey = `naceb:runtime:message:${eventId}`
    const processSub = this.obs.listen(processKey, (m: any) => hooks.onProcess(m?.opt?.chunk))
    // Terminal hooks must be attached BEFORE start so done/failure can't be missed.
    const ev = this.naceb.getEvent(eventId)!
    ev.afterTDone(() => {
      this.reqEvents.delete(spec.reqId)
      this.obs.off(processSub)
      hooks.onResponse(this.naceb.consumeEvent(eventId), true)
    })
    ev.afterTFailure(() => {
      this.reqEvents.delete(spec.reqId)
      this.obs.off(processSub)
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
