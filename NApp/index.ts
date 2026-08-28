/**
 * NApp public API barrel: the facade, its options, the `napp:` event surface, the notify stream, and the
 * layer error.
 */

export { NApp } from './NApp.ts'
export type { NAppOpts, AbilityRequestHandle, EventRequestHandle, SubscribeHandle } from './types.ts'
export { NAppError, nappInbound, nappInternal, nappOutbound } from './errors.ts'

export { NAppInternal } from './events.ts'
export type { NotifyWarningPayload } from './events.ts'

// Exported for its TYPE and buffer cap; consumers receive an instance from `subscribe`.
export { NotifyStream, NOTIFY_BUFFER_MAX } from './notifyStream.ts'
export type { NotifyStreamOpts } from './notifyStream.ts'

export type { ReadonlyBus } from '../EventBus.ts'
