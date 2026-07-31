/**
 * NACAB public API barrel.
 *
 * Exposes the assembly (Nacab), the authoring base (AbilityHandler), the runtime record
 * (AbilityInstance), the public declaration type (Ability), the observation bus type
 * (ReadonlyBus), and the layer error (NACABError). Mirrors NACEB's barrel shape.
 */

export { Nacab } from './NACAB.ts'
export { AbilityHandler, AbilityInstance } from './types.ts'
export type { Ability } from './types.ts'
export type { ReadonlyBus } from '../EventBus.ts'
export { NACABError, nacabInbound, nacabInternal, nacabOutbound } from './errors.ts'
