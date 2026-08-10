/**
 * NASDK 根入口。NApp 是 default——它是你唯一必然要实例化的那个；其余六个具名：
 *
 *     import NApp, { EventBus } from '@chenyfan/nasdk'
 *     import NApp, { NACEB, NACAB } from '@chenyfan/nasdk'
 *
 *   NApp      default，门面，用户实例化的那个（内部装配 NACP + NACT）
 *   NACP      协议层
 *   NACT      传输层
 *   NACEB     内建 event Processor
 *   NACAB     内建 ability Processor
 *   EventBus  事件总线类
 *   utils     id 工具（uuid / uid）
 *
 * 只有这七个。类型、错误类、事件名常量、Handler 基类等各层自己的东西，从各层的子路径取——
 * package.json 的 exports 按层开了口子：
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
