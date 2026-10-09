import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NAppError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NApp', phase, code, message)
  }
}

export const nappInbound = (code: string, message: string) => new NAppError('inbound', code, message)
export const nappInternal = (code: string, message: string) => new NAppError('internal', code, message)
export const nappOutbound = (code: string, message: string) => new NAppError('outbound', code, message)
