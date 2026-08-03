/**
 * NACP errors — layer-scoped subclass of the shared NASDKError (layer fixed to 'NACP').
 * phase (inbound/internal/outbound) is the constant cross-layer axis; the three factories preset it.
 *
 * `code` is the stable kebab-case machine code the binding layer translates into
 * response{isOk:false, whyNotOk} — protocol-level failure reasons stay in meta, never in payload.
 */

import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACPError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NACP', phase, code, message)
  }
}

/** An inbound message could not be admitted / a peer went away under an in-flight request. */
export const nacpInbound = (code: string, message: string) => new NACPError('inbound', code, message)
/** Failure while working inside (no bound processor, unknown subscription, bad state). */
export const nacpInternal = (code: string, message: string) => new NACPError('internal', code, message)
/** Failure sending outward (unroutable destination, response timeout, stopping). */
export const nacpOutbound = (code: string, message: string) => new NACPError('outbound', code, message)
