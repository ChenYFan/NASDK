# NACP Signal 实施计划

> 计划态文档，仅用于本轮 Signal 设计与实施；不代表当前已实现契约。

## 目标与边界

Signal 是对一个仍在执行的 Event Request 发送的可靠单向消息。NACP 增加一个 `signal` Message type，`meta.kind` 固定为 `normal | pause | resume | abort`。

- Signal 自铸 `id`；`signal.meta.parentId` 指向原 Event Request 的 `request.id`。
- Signal 只期待 ACK，不期待 Response，不建立专属 Notify/过程流。
- ACK 回指 Signal 自身：`ack.meta.parentId = signal.id`。
- `normal` 可携带 opaque payload；`pause/resume/abort` 的信封不出现 `payload` 键。
- ACK 只表示目标 NACP 收到 Signal；目标 req 不存在、已结束或状态不允许仅在接收端观测，不改变发送端 ACK 结果。
- Signal 仅针对 Event Processor；Ability Processor 不支持 Signal。
- 所有公共出站方法异步：`NApp.signal()` 与 `NACP.signal()` 返回 `Promise<boolean>`，收到 ACK 后 resolve `true`。
- 本轮不更新 README 或 `docs/` 正式文档。
- NACP `PROTOCOL_V` 由 `1.0` 升为 `2.1`；同 major 兼容规则不变，因此旧版在 register 阶段直接因 major 不同而拒绝。
- NACT wire version 保持 `0x01`；Signal 不改变分片头或承载格式，无需升级 NACT。

## 第一阶段：协议类型与构包

修改 `NACP/types.ts`、`NACP/index.ts` 和根导出：

1. `NACPType` 增加 `'signal'`。
2. 新增 `SignalKind = 'normal' | 'pause' | 'resume' | 'abort'`。
3. 新增 `SignalMeta { parentId, kind }`。
4. 将 Signal 写成按 `meta.kind` 判别的联合：
   - `NormalSignalMessage`：必有 payload。
   - 控制 Signal：`payload?: undefined`，构包时完全省略字段。
5. `NACPMessage` 联合与公共 barrel 导出 Signal 类型。
6. `BuildOpt` 增加 Signal 构包字段，`buildMessage('signal')` 自动生成独立消息 ID。
7. 协议类型完成后将 NACP `PROTOCOL_V` 更新为 `{ major: 2, minor: 1 }`。

验收：类型测试证明 control Signal 不能携带 payload；codec 往返保持字段，control Signal 线上无 payload；Signal ID、Request ID、ACK ID 三者独立；NACP 1.x 对端在 register 阶段得到 `version-mismatch`。

## 第二阶段：Processor 契约

修改根 `types.ts`：

```ts
type ProcessorSignalSpec =
  | { signalId: string; reqId: string; kind: 'normal'; payload: unknown }
  | { signalId: string; reqId: string; kind: 'pause' | 'resume' | 'abort' }

interface EventProcessor extends Processor {
  signal(spec: ProcessorSignalSpec): Promise<void>
}
```

1. 通用 `Processor` 保持 `list + push`，避免污染 Ability。
2. `AbilityProcessor` 保持现状。
3. `NApp.bindProcessor('event', ...)` 的类型收窄为 EventProcessor；`getProcessor` 增加 kind overload，使 NACP 取 event 时可见 `signal()`。
4. 自定义 Event Processor 编译时必须实现异步 Signal 入口。

验收：NACAB 无需伪造 Signal；缺失 `signal()` 的 Event Processor 在类型检查中失败。

## 第三阶段：NACP 与 NApp 纵向链路

修改 `NACP/NACP.ts`、`NApp/NApp.ts` 及公共类型/导出：

1. NACP 新增异步出站：

```ts
signal(to: string, opt: SignalOpt): Promise<boolean>
```

2. 使用 `send4Ack`，进入 backlog/ACK pending/重连续发；不进入 ResponsePendingTable，不创建 AutoSub。
3. NApp 新增同形异步门面，并遵循 stopping 时返回 `false` 的现有约定。
4. `inbound` 增加与 `onAck/onRequest` 同级的 `onSignal`。
5. 入站顺序沿用可靠消息规则：先 ACK，再按 `signal.id` 去重，首次才调用 `EventProcessor.signal()`。
6. `onSignal` 捕获 Processor 异步失败，发送方仍保有 ACK，不回 Response。
7. Gateway 对 Signal 与 ACK 都只透明转发，不代答、不创建本地可靠状态。
8. 目标 req 不存在/已结束/状态不匹配统一落接收端 Signal error 观测；NACP 不读取 NACEB 错误码。

验收：`signal → ack` 闭合；重复 Signal 只重复 ACK、不重复投递；断线重连后 Signal 重发；未知目标仍 ACK 且只在接收端报错；Gateway 端到端 ACK。

## 第四阶段：EventBus 观测面

修改 `NACP/events.ts`、相关 barrel 与 NACEB runtime 事件定义：

1. `inboundEvent/outboundEvent` 自动覆盖：
   - `nacp:inbound:signal`
   - `nacp:outbound:signal`
2. 增加 `nacp:internal:signal:error`，NACP 层 reason 保持通用，例如 `no-event-processor | processor-rejected`。
3. 增加原调用实体事件 `nacp:event:{reqId}:signal`，使 `nacp:event:{reqId}:*` 能观察 Request 的 process/signal/response 完整交互。
4. NACEB 增加 Signal runtime 观测，记录 Event 收到的 kind/signalId；pause/resume/failure 的结果继续由现有 transition 事件表达，避免重复状态事件。
5. 更新所有事件 payload 类型与公共导出。

验收：方向事件、调用实体事件、internal error、NACEB runtime Signal 事件各自只发一次；重放 Signal 不重复发业务投递事件。

## 第五阶段：NACEB Signal 执行模型

修改 NACEB adaptor、Event/Pipeline/Task instance 与 controller/type：

1. NACEB adaptor 维护活动 `reqId → eventId`，push 成功后登记，Event done/failure 后删除。
2. adaptor 实现 `EventProcessor.signal()`：按 reqId 找 Event，再分派四类 Signal。
3. Event 直接处理控制 Signal：
   - `pause` 调现有 pause 链。
   - `resume` 调现有 resume 链。
   - `abort` 执行不可恢复收束，最终进入现有 `failure`，原 Request 返回 `isOk:false`。
4. `normal` 属于整个 Event 的持续输入。Event 持有 FIFO Inbox，Pipeline 是唯一语义解释者。
5. `PipelineHandler` 新增异步可选入口：

```ts
onNormalSIG?(this: PipelineInstance, signal: NormalSignal): void | Promise<void>
```

6. `onNormalSIG` 不返回 Disposition；Pipeline 内部自行决定更新 state、暂存或通知当前 Task，框架不解释返回值。
7. `TaskHandler` 新增异步可选 `onSignal`；Task 只接收 `normal | abort`，没有 pause/resume 概念。
8. Pipeline 获得明确的当前 Task 通知能力，只有 Pipeline 主动调用时 normal Signal 才进入 Task。
9. Task 的 abort 路径通过 `onSignal({kind:'abort'})` 进入，并继续激活内部标准 `AbortController`；保留 `this.abortSignal` 供 fetch/stream 等标准 API 使用。
10. pause 与 abort 对 Task 都是 abort，但上层后续不同：pause 保留 stopped Task 供 resume；abort 清理下层并令 Event failure。
11. Pipeline `onNormalSIG` 与 `next()`/transition 必须经 controller 串行，禁止网络回调直接并发调用 Pipeline Handler。
12. Event 终局时关闭并清理 Inbox；终局后到达的 Signal 由 adaptor 作为 target ended 报错。

已确认执行细节：

- 每条 normal Signal 只按 FIFO 顺序调用一次 `PipelineHandler.onNormalSIG()`；若需延后，由 Pipeline 自行保存在 `this.state`，框架不猜测消费状态、不自动重投。
- Pipeline 通过 `PipelineInstance.signalTask(signal): Promise<void>` 通知当前 Task；Instance 负责查找当前 Task 并调用其 `onSignal`，Handler 不直接访问 Controller。
- abort 最终沿用现有 adaptor 协议级失败：`whyNotOk='processor-failed'`，payload 为 `{ error: 'aborted' }`。

验收：normal Signal 严格按 Event 顺序进入 Pipeline；只有显式支持的 Task 收到下发；pause/resume 可恢复同一 Task；abort 不可恢复并产生失败 Response；所有 reqId 映射和 Inbox 均在终局清理。

## 第六阶段：测试矩阵

新增 `test/full/signal.test.mjs`，并更新 NACP/NApp/NACEB 既有测试与 `_kit.mjs`：

1. 协议：四种 kind、独立 ID、parentId 两级关系、payload 有无约束、codec 往返。
2. ACK：Signal Promise 等 ACK；ACK 回指 signal.id；ACK 自身不被 ACK。
3. 去重：重复 Signal 再 ACK但只投递一次。
4. 错误边界：未知 req、已终局、错误状态、无 Event Processor均不产生 Response，发送方仍收到 ACK，接收端有 error 事件。
5. NACEB normal：Pipeline 收到有序输入；Pipeline 主动下发时 Task 收到；不支持的 Task 不被调用。
6. pause/resume：运行中和 paused 状态边界；重复 pause/resume 的本地错误观测。
7. abort：running/pending/paused 下不可恢复 failure；原 Request 最终失败 Response；映射清理。
8. 可靠性：Signal 离线 backlog、ACK 超时 offline、同 appId 重连续发、宽限到期 false。
9. Gateway：Signal 与 ACK 端到端透明转发。
10. EventBus：NACP 方向/调用实体/internal 以及 NACEB runtime 观测。
11. 容量与压力：大量 Signal 不泄漏 ACK waiter、reqId 映射或 Event Inbox。

## 第七阶段：最终验证

1. 不修改 README、`docs/nacp.md`、`docs/napp.md`、`docs/naceb.md` 等正式文档；本轮契约只以源码、类型、测试和本计划为准。
2. NACT `NACT_VERSION=0x01` 与 framing 测试保持不变。
3. 不在本计划中推导或修改 npm package version；用户指定的是 NACP 协议版本。
4. 执行：
   - Signal 定向测试。
   - `npm test`。
   - `NASDK_SLOW=1 npm test`。
   - `npm run typecheck`。
   - `npm run build`。

## 已确认实施决策

1. Event Inbox 每条 normal Signal 只交付一次；延后内容由 Pipeline 自己持有。
2. Pipeline 使用 `PipelineInstance.signalTask(signal): Promise<void>` 通知当前 Task。
3. abort 令原 Event Request 以 `whyNotOk='processor-failed'`、payload `{ error: 'aborted' }` 失败结束。
4. NACP 协议版本为 `2.1`，不兼容旧 major；NACT wire version 保持 `1`。
5. 本轮不更新正式文档。

## Request 公共句柄（实施中确认）

`NApp.request()` 不再直接返回最终 Response Promise，改为同步返回请求句柄，使调用方在 Request 执行期间持有 `reqId` 并可发送 Signal。

建议按 kind 判别：

```ts
interface AbilityRequestHandle {
  reqId: string
  response: Promise<ResponseMessage>
}

interface EventRequestHandle extends AbilityRequestHandle {
  process: AsyncIterable<unknown>
}
```

- Event AutoSub 同时支持 request opt 的 `onProcess` callback 与 `handle.process` AsyncIterable；每条过程 Notify 同时投递两者，Response 到达时结束流。
- Ability 没有过程流，因此句柄不暴露 `process`。
- `request()` 必须同步生成 reqId、创建有界 process stream、建立 AutoSub 本地监听，最后才让 Request 出站；调用返回时 callback 与 stream 都已就绪，维持不漏首包保证。
- 消费者 `break` 只表示不再读取过程流，不自动 unsubscribe、abort 或取消原 Event Request；AutoSub 仍由终局 Response 关闭。
- `onProcess` 明确保留，作为与 AsyncIterable 并列的消费方式；两者允许同时使用，与显式 subscribe 的 callback + stream 语义一致。
