# Pipeline 层

Pipeline是Event与Task之间的流程层。

Pipeline专注于**用当前状态和上一个Task的结果决定下一步**。

流程由[PipelineHandler](../registration/pipeline-handler)定义，运行时由`PipelineInstance`承载。每个Event最多对应一个PipelineInstance。

## 接口

Pipeline没有独立的`PipelineInterface`。它通过`PipelineStep`描述下一步要派发的Task：

```ts
interface PipelineStep {
  task: string
  input: unknown
}
```

| 字段    | 作用                              |
| ------- | --------------------------------- |
| `task`  | 要执行的TaskHandler名称           |
| `input` | 传给下一TaskInstance的输入        |

`PipelineHandler.next()`返回`PipelineStep`，具体规则见[PipelineHandler](../registration/pipeline-handler)。

## 实例

```ts
class PipelineInstance {
  readonly id: string
  readonly event: EventInstance
  readonly handler: PipelineHandler
  readonly state: Record<string, any>

  status: PipelineStatus
  currentTaskId: string | null

  getTask(): TaskInstance | null
  signalTask(signal: TaskSignal): Promise<void>
  consume(): unknown
}
```

| 成员            | 作用                                     |
| --------------- | ---------------------------------------- |
| `id`            | PipelineInstance的唯一ID                 |
| `event`         | 当前处理的EventInstance                  |
| `handler`       | 当前绑定的PipelineHandler                |
| `state`         | 跨Task步骤共享的状态空间                 |
| `status`        | 当前Pipeline状态                         |
| `currentTaskId` | 当前TaskInstance的ID                     |
| `getTask()`     | 获取当前TaskInstance；不存在时返回`null` |
| `signalTask()`  | 将信号发送给当前TaskInstance             |
| `consume()`     | 取出终局结果并移除本PipelineInstance     |

`PipelineHandler.next()`与`onNormalSIG()`的`this`绑定到PipelineInstance。Handler全局复用，流程中的可变数据应写入`this.state`。

:::warning
`status`与`currentTaskId`由NACEB维护，不应由Handler修改。
:::

## 调度

`PipelineFSMController`负责校验PipelineHandler是否已注册、为Event创建并持有PipelineInstance、按Event查询实例，以及转发普通信号。

每一刻到来时，`PipelineFSMController`按以下顺序检查所有PipelineInstance：

1. 处理`running` Pipeline的已终局Task。
2. Task为`done`时消费其结果；若为[`$terminal`](../builtins/terminal)，Pipeline进入`done`，否则将结果传给`PipelineHandler.next()`并派发下一步。
3. Task为`stopped`时，Pipeline进入`paused`。
4. Task为`failure`时消费错误结果，Pipeline进入`failure`。
5. 对`pending` Pipeline调用首次`next(undefined)`，并派发第一个Task。

与Event层不同，Pipeline层每一刻可以推进多个PipelineInstance。

暂停、恢复和普通信号由PipelineInstance响应，不等待下一刻；具体调用由上层EventInstance发起。

状态变化见[生命周期](../lifecycle)，NACEB的时钟机制见[刻](../advanced/tick)。
