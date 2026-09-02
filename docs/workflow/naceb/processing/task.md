# Task 层

Task是NACEB的最小执行单元，负责执行一个具体任务并返回结果。

执行逻辑由[TaskHandler](../registration/task-handler)定义，运行时由`TaskInstance`承载。

## 接口

Task没有独立的`TaskInterface`。Pipeline通过[`PipelineStep`](./pipeline#接口)指定Task名称与输入。

Task正常完成后，返回值由`TaskResponse`承载：

```ts
class TaskResponse {
  readonly result: unknown
}
```

Task接收普通信号和中止信号：

```ts
interface NormalSignal {
  signalId: string
  kind: 'normal'
  payload: unknown
}

type TaskSignal = NormalSignal | { kind: 'abort' }
```

## 实例

```ts
class TaskInstance {
  readonly id: string
  readonly pipeline: PipelineInstance
  readonly name: string
  readonly busyKeys: string[]
  readonly input: unknown
  readonly state: Record<string, any>

  status: TaskStatus
  response?: TaskResponse
  error?: unknown

  readonly eventId: string
  readonly abortSignal: AbortSignal

  processingResultReport(chunk: unknown): void
  onSignal(signal: TaskSignal): Promise<void>
  isBlocked(): boolean
  consume(): unknown
}
```

| 成员                            | 作用                          |
| ------------------------------- | ----------------------------- |
| `id`                            | TaskInstance的唯一ID          |
| `pipeline`                      | 所属PipelineInstance          |
| `name`                          | 当前绑定的TaskHandler名称     |
| `busyKeys`                      | 本Task占用的资源              |
| `input`                         | PipelineStep提供的输入        |
| `state`                         | 当前TaskInstance的状态空间    |
| `status`                        | 当前Task状态                  |
| `response`                      | 正常完成后的TaskResponse      |
| `error`                         | 执行失败时的错误              |
| `eventId`                       | 所属Event的ID                 |
| `abortSignal`                   | 协商终止当前执行的AbortSignal |
| `processingResultReport(chunk)` | 上报一条过程消息              |
| `onSignal()`                    | 处理普通信号或中止信号        |
| `isBlocked()`                   | 判断本Task是否属于BlockedTask |
| `consume()`                     | 取出结果并移除本TaskInstance  |

`TaskHandler.execute()`与`onSignal()`的`this`绑定到TaskInstance。

跨Task步骤的数据应写入`this.pipeline.state`。

:::warning
`status`、`response`与`error`由NACEB维护，不应由Handler修改。
:::

## Async 与 Blocked

Task类型只由`busyKeys`区分：

| `busyKeys`           | 类型        | 调度方式               |
| -------------------- | ----------- | ---------------------- |
| 未设置或空数组       | AsyncTask   | 不限制并发             |
| 包含一个或多个资源键 | BlockedTask | 取得所有对应资源后执行 |

相同`busyKey`的BlockedTask共用一条Lane，同一时刻最多运行一个。

包含多个`busyKeys`的Task必须同时位于所有Lane的队首，且所有Lane均空闲。

`payloadSchema`会在TaskInstance创建前校验输入，但不会转换输入。

定义方式见[TaskHandler](../registration/task-handler)。

## 调度

`TaskFSMController`负责查找TaskHandler、校验输入、创建并持有TaskInstance，以及维护Async队列和Blocked Lane。

每一刻到来时，`TaskFSMController`会：

1. 将Async队列中所有`pending` Task转为`running`并调用对应`TaskHandler.execute()`。
2. 检查Blocked Lane，将同时满足所有资源条件的`pending` Task转为`running`并执行。

Task执行完成后，由TaskInstance直接进入`done`、`failure`或`stopped`并唤醒下一刻，不等待Task层再次调度。结果由Pipeline层在下一刻消费。

信号与协商终止由TaskInstance直接响应。暂停与恢复见[生命周期](../lifecycle#暂停与恢复)，时钟机制见[刻](../advanced/tick)。
