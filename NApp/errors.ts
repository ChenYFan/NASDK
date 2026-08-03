/**
 * NApp errors — layer-scoped subclass of the shared NASDKError (layer fixed to 'NApp').
 * phase (inbound/internal/outbound) is the constant cross-layer axis; the three factories preset it.
 */

import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NAppError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NApp', phase, code, message)
  }
}

/** A handshake resolved to the wrong peer (connected to someone other than `expect`). */
export const nappInbound = (code: string, message: string) => new NAppError('inbound', code, message)
/** Bad assembly (no id, binding a processor after start, …). */
export const nappInternal = (code: string, message: string) => new NAppError('internal', code, message)
/** An outbound call was refused (the App is stopping). */
export const nappOutbound = (code: string, message: string) => new NAppError('outbound', code, message)
