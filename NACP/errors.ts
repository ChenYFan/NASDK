import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACPError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NACP', phase, code, message)
  }
}

export const nacpInbound = (code: string, message: string) => new NACPError('inbound', code, message)
export const nacpInternal = (code: string, message: string) => new NACPError('internal', code, message)
export const nacpOutbound = (code: string, message: string) => new NACPError('outbound', code, message)
