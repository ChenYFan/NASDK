import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACTError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string, cause?: unknown) {
    super('NACT', phase, code, message, cause)
  }
}

export const nactInbound = (code: string, message: string, cause?: unknown) => new NACTError('inbound', code, message, cause)
export const nactInternal = (code: string, message: string, cause?: unknown) => new NACTError('internal', code, message, cause)
export const nactOutbound = (code: string, message: string, cause?: unknown) => new NACTError('outbound', code, message, cause)

export function codeOf(reason: unknown, fallback: string): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string') return reason.code
  return fallback
}
