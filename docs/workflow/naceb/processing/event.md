# Event 层

Event是NACEB的顶层处理单元。

每个Event由一个Pipeline处理，并以Pipeline的终局结果作为自身结果。

Event的数据由`EventInterface`描述，运行时由`EventInstance`承载。

Event的创建方式见[构造一个NACEB](../construction)。

## 接口

```ts
interface EventInterface {
  readonly id: string
  name: string
  pipelineName: string
  payload: unknown
  scope?: string
  blockedBy?: string[]
  parentId?: string
}
```

| 字段           | 作用                                      |
| -------------- | ----------------------------------------- |
| `id`           | Event的唯一ID                             |
| `name`         | Event名称                                 |
| `pipelineName` | 处理本Event的Pipeline名称                 |
| `payload`      | 交给Pipeline处理的业务数据                |
| `scope`        | 同一scope的Event不会同时激活              |
| `blockedBy`    | 前置Event ID；前置Event终局后才会进入队列 |
| `parentId`     | SubEvent所属的父Event ID                  |

:::danger
`parentId`由[SubEvent](../advanced/subevent)内建任务设置并追踪，普通任务不应当去填写这个字段。
:::

## 实例

```ts
class EventInstance implements EventInterface {
  status: EventStatus
  final?: unknown

  getPipeline(): PipelineInstance | null
  start(): Promise<void>
  pause(): Promise<boolean>
  resume(): Promise<boolean>
  normalSIG(signal: NormalSignal): Promise<void>
  abort(): Promise<void>
  consume(): unknown
}
```

| 成员            | 作用                                           |
| --------------- | ---------------------------------------------- |
| `status`        | 当前Event状态                                  |
| `final`         | `done`或`failure`后的最终结果                  |
| `getPipeline()` | 获取当前PipelineInstance；尚未激活时返回`null` |
| `start()`       | 使`idle`状态的Event开始运行                    |
| `pause()`       | 暂停当前Event及其下层实例                      |
| `resume()`      | 恢复已暂停的Event及其下层实例                  |
| `normalSIG()`   | 向PipelineHandler发送普通信号                  |
| `abort()`       | 清理下层实例并使Event进入`failure`             |
| `consume()`     | 取出终局结果并移除本EventInstance              |

通过`naceb.getEvent(id)`、`naceb.listEvent()`可以取得EventInstance。

PipelineHandler中也可通过`this.event`访问当前实例。

:::warning
只有`done`和`failure`状态的EventInstance可以消费。消费后，该实例会从NACEB中移除。
:::

## 调度

`EventFSMController`负责创建并持有EventInstance队列，同时提供实例查询、终局消费和时钟存活判断。

每一刻到来时，`EventFSMController`按固定顺序检查队列。

每一刻最多推进一个Event动作：

1. 对齐运行中的Event与Pipeline：Pipeline终局时收取结果；否则根据当前Task类型，将Event对齐为`processing`或`pending`。
2. 激活一个`queue`中的Event：同`scope`没有其他Event占用时，进入`activating`并创建PipelineInstance。
3. 解除一个`blocked`的Event：`blockedBy`中的Event均已终局或不存在时，进入`queue`。
4. 自动消费带有`bypassConsume`的终局Event。该步骤不占用每刻一个动作的额度。

`idle`与`paused`不会由调度器主动推进，分别等待`start()`与`resume()`。

`start()`、`pause()`、`resume()`、`normalSIG()`和`abort()`由EventInstance直接响应，不等待下一刻。

状态变化见[生命周期](../lifecycle)，NACEB的时钟机制见[刻](../advanced/tick)。
