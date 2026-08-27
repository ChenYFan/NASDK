/**
 * NACEB public API barrel.
 *
 * Exposes the assembly (NACEB), authoring bases (PipelineHandler, TaskHandler), the public contracts and
 * status/const types, plus the instance classes and hook interfaces consumers observe. Internal
 * machinery (the FSMController classes, private helpers) is intentionally not re-exported.
 */

export { NACEB } from './NACEB.ts'

export {
  // authoring bases
  PipelineHandler, TaskHandler, TaskResponse,
  // builtin reserved task names
  TERMINAL, FIRE4SUBEVENT, WAIT4SUBEVENT, BUILTIN_NAMES,
} from './types.ts'

export type {
  // status
  EventStatus, PipelineStatus, TaskStatus,
  // contracts
  PipelineStep, NormalSignal, TaskSignal,
  EventInterface, PushOpts, SubEventSpec,
  NACEBHooks, EventHooks,
  // event alias (lookup table) + NACP declaration item
  EventAlias, Event,
} from './types.ts'

// read-only observation view (root-level EventBus concept; eventBusObs returns one)
export type { ReadonlyBus } from '../EventBus.ts'

// instance classes consumers may receive from hooks / getters
export { TaskInstance } from './controller/TaskFSMController.ts'
export { PipelineInstance } from './controller/PipelineFSMController.ts'
export { EventInstance } from './controller/EventFSMController.ts'

// layer error + veto control signal (throw new VetoT('reason') from a beforeT hook to veto that transition)
export { NACEBError, nacebInbound, nacebInternal, nacebOutbound, VetoT } from './errors.ts'
