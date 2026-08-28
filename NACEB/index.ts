/**
 * NACEB public API barrel: the assembly, authoring bases, contracts, instance classes, and the layer error
 * + veto signal.
 */

export { NACEB } from './NACEB.ts'

export {
  PipelineHandler, TaskHandler, TaskResponse,
  TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT, BUILTIN_NAMES,
} from './types.ts'

export type {
  EventStatus, PipelineStatus, TaskStatus,
  PipelineStep, NormalSignal, TaskSignal,
  EventInterface, PushOpts, SubEventSpec,
  NACEBHooks, EventHooks,
  EventAlias, Event,
} from './types.ts'

export type { ReadonlyBus } from '../EventBus.ts'

export { TaskInstance } from './controller/TaskFSMController.ts'
export { PipelineInstance } from './controller/PipelineFSMController.ts'
export { EventInstance } from './controller/EventFSMController.ts'

// VetoT: throw new VetoT('reason') from a beforeT hook to veto that transition.
export { NACEBError, nacebInbound, nacebInternal, nacebOutbound, VetoT } from './errors.ts'
