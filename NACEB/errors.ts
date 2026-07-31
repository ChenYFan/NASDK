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
 * It is NOT an error: it's a normal control-flow signal that means "don't transition this beat".
 * NACEB catches it, keeps the instance in its current state, and requests a fresh alertTick so the next
 * beat retries (typically the veto hook mutated a gate first, e.g. blockedBy/scope, so the retry decides differently).
 *
 * Crucially it is distinguished from a real hook bug by TYPE (instanceof VetoT), NOT by message string:
 * any OTHER throw (TypeError, plain Error, NACEBError, …) is treated as an accidental hook failure and
 * routed to failure (terminal) — so a buggy hook can never masquerade as an intentional veto and spin
 * forever. The optional `reason` is human-readable only (goes into the runtime:warning), never matched.
 */
export class VetoT extends Error {
  constructor(reason?: string) { super(reason ?? 'vetoed'); this.name = 'VetoT' }
}
