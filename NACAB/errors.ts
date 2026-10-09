import { NASDKError } from '../types.ts'
import type { NASDKErrorPhase } from '../types.ts'

export class NACABError extends NASDKError {
  constructor(phase: NASDKErrorPhase, code: string, message: string) {
    super('NACAB', phase, code, message)
  }
}

export const nacabInbound = (code: string, message: string) => new NACABError('inbound', code, message)
export const nacabInternal = (code: string, message: string) => new NACABError('internal', code, message)
export const nacabOutbound = (code: string, message: string) => new NACABError('outbound', code, message)
