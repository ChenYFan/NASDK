/**
 * NACEB errors — layer-scoped subclass of the shared NASDKError (layer fixed to 'NACEB').
 * phase (inbound/internal/outbound) is the constant cross-layer axis; the three factories preset it.
 */

import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACEBError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NACEB', phase, code, message)
  }
}

/** An event could not be admitted (eventName empty / not in eventAlias and no pipeline carried). */
export const nacebInbound = (code: string, message: string) => new NACEBError('inbound', code, message)
/** Failure while working inside (unregistered pipeline, beforePushEvent veto, handler threw). */
export const nacebInternal = (code: string, message: string) => new NACEBError('internal', code, message)
/** Failure emitting a result outward. */
export const nacebOutbound = (code: string, message: string) => new NACEBError('outbound', code, message)

/**
 * VetoT — the veto control signal, thrown from a beforeT{State} hook to abort THIS transition.
 * NOT an error: NACEB catches it by TYPE (instanceof), keeps the instance in its current state and retries
 * next beat. Any OTHER throw is treated as a hook bug → failure (terminal). `reason` is human-readable only.
 */
export class VetoT extends Error {
  constructor(reason?: string) { super(reason ?? 'vetoed'); this.name = 'VetoT' }
}
