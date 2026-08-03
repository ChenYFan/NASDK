/**
 * NACT errors — layer-scoped subclass of the shared NASDKError (layer fixed to 'NACT').
 * phase (inbound/internal/outbound) is the constant cross-layer axis; the three factories preset it.
 */

import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACTError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NACT', phase, code, message)
  }
}

/** Bad bytes arriving: over-cap / undersized frame, decode failure, malformed fragment. */
export const nactInbound = (code: string, message: string) => new NACTError('inbound', code, message)
/** Failure while working inside: reassembly timeout, listen/dial setup failure. */
export const nactInternal = (code: string, message: string) => new NACTError('internal', code, message)
/** Failure sending outward: no such peer, socket write failure. */
export const nactOutbound = (code: string, message: string) => new NACTError('outbound', code, message)
