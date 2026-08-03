/**
 * NApp public API barrel.
 *
 * Exposes the facade (NApp), its constructor options, and the layer error. The two ref boxes are
 * intentionally not re-exported: they are the private capability surfaces the parent cuts for its children,
 * and nothing outside the assembly should be able to name — let alone forge — one.
 */

export { NApp } from './NApp.ts'
export type { NAppOpts } from './types.ts'
export { NAppError, nappInbound, nappInternal, nappOutbound } from './errors.ts'

// read-only observation view of the shared bus (app.bus.readonly returns one)
export type { ReadonlyBus } from '../EventBus.ts'
