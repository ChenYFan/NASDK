/**
 * NACAB public API barrel: the assembly, the authoring base, the runtime record, the declaration type,
 * the observation bus type, and the layer error.
 */

export { NACAB } from './NACAB.ts'
export { AbilityHandler, AbilityInstance } from './types.ts'
export type { Ability } from './types.ts'
export type { ReadonlyBus } from '../EventBus.ts'
export { NACABError, nacabInbound, nacabInternal, nacabOutbound } from './errors.ts'
