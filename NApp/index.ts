/**
 * NApp public API barrel.
 *
 * Exposes the facade (NApp), its constructor options, the `napp:` event surface, the notify stream, and the
 * layer error. NApp's children hold nothing but `this.napp` — there is no private-capability box to leak, and
 * `processors` stays private (the public door is `bindProcessor` in, `getProcessor` out).
 */

export { NApp } from './NApp.ts'
export type { NAppOpts } from './types.ts'
export { NAppError, nappInbound, nappInternal, nappOutbound } from './errors.ts'

// the `napp:` observation surface — one name today (a subscribe stream dropped a buffered notify)
export { NAppInternal } from './events.ts'
export type { NotifyWarningPayload } from './events.ts'

// the async-iterable half of `subscribe`. Exported for its TYPE and its buffer cap; consumers receive an
// instance from `subscribe` rather than constructing one.
export { NotifyStream, NOTIFY_BUFFER_MAX } from './notifyStream.ts'
export type { NotifyStreamOpts } from './notifyStream.ts'

// read-only observation view of the shared bus (app.bus.readonly returns one)
export type { ReadonlyBus } from '../EventBus.ts'
