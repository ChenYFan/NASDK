/**
 * NASDK root entry. NApp is the default export — the one thing you must instantiate; the other six are named:
 *
 *     import NApp, { EventBus } from '@chenyfan/nasdk'
 *     import NApp, { NACEB, NACAB } from '@chenyfan/nasdk'
 *
 *   NApp      default, the facade, what a user instantiates (assembles NACP + NACT internally)
 *   NACP      the protocol layer
 *   NACT      the transport layer
 *   NACEB     the built-in event Processor
 *   NACAB     the built-in ability Processor
 *   EventBus  the event-bus class
 *   utils     id helpers (uuid / uid)
 *
 * Only these seven. Per-layer types, error classes, event-name constants, Handler bases, etc. come from each
 * layer's own subpath — package.json's exports open a per-layer entry:
 *
 *     import type { TransportSpec } from '@chenyfan/nasdk/NACT'
 *     import { TaskHandler, PipelineHandler } from '@chenyfan/nasdk/NACEB'
 *     import { AbilityHandler } from '@chenyfan/nasdk/NACAB'
 *     import type { Processor } from '@chenyfan/nasdk/types'
 */

import { NApp } from './NApp/index.ts'

export default NApp

export { NApp }
export { NACP } from './NACP/index.ts'
export { NACT } from './NACT/index.ts'
export { NACEB } from './NACEB/index.ts'
export { NACAB } from './NACAB/index.ts'
export { EventBus } from './EventBus.ts'
export * as utils from './utils/id.ts'
