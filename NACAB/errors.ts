/**
 * NACAB errors — layer-scoped subclass of the shared NASDKError (layer fixed to 'NACAB').
 * phase (inbound/internal/outbound) is the constant cross-layer axis; the three factories preset it.
 */

import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACABError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NACAB', phase, code, message)
  }
}

/** A request could not be admitted (unknown ability). */
export const nacabInbound = (code: string, message: string) => new NACABError('inbound', code, message)
/** Failure while working inside (handler threw — usually let it bubble raw instead). */
export const nacabInternal = (code: string, message: string) => new NACABError('internal', code, message)
/** Failure emitting a result outward. */
export const nacabOutbound = (code: string, message: string) => new NACABError('outbound', code, message)
