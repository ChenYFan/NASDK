import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACEBError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NACEB', phase, code, message)
  }
}

export const nacebInbound = (code: string, message: string) => new NACEBError('inbound', code, message)
export const nacebInternal = (code: string, message: string) => new NACEBError('internal', code, message)
export const nacebOutbound = (code: string, message: string) => new NACEBError('outbound', code, message)

// Thrown from a beforeT hook to abort THIS transition: caught by TYPE, stays in current state.
export class VetoT extends Error {
  constructor(reason?: string) { super(reason ?? 'vetoed'); this.name = 'VetoT' }
}
