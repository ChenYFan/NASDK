# TaskHandler

TaskHandler是NACEB内最小的任务执行单元，可以由外部定义具体的执行内容。

[TaskInstance](../processing/task) 执行期间会绑定对应的TaskHandler。

## 接口

```ts
abstract class TaskHandler<R = unknown> {
  abstract readonly name: string
  readonly busyKeys?: string[]
  readonly payloadSchema?: ZodType
  onSignal?(this: any, signal: TaskSignal): void | Promise<void>
  abstract execute(this: any): Promise<R>
}
```

| 成员            | 作用                                   |
| --------------- | -------------------------------------- |
| `name`          | Pipeline 派发 Task 时使用的名称        |
| `busyKeys`      | 声明需要独占的资源                     |
| `payloadSchema` | 在创建 TaskInstance 前校验 `input`     |
| `execute()`     | 执行 Task                              |
| `onSignal()`    | 接收发给当前 Task 的普通信号或中止信号 |

:::tip
`payloadSchema` 只负责校验，不会转换 `execute()` 的参数。

资源占用和输入校验规则见 [Task 层](../processing/task)。
:::

:::warning
如果你没有填写`busyKeys`，本TaskHandler会被标记为AsyncTask。

AsyncTask没有并发限制，很适合做一些轻量任务。

但正因如此，AsyncTask不适合运行需要独占资源的任务。这一部分任务应该标记自己的busyKey。
:::

## 定义 Handler

```ts
import { TaskHandler } from '@chenyfan/nasdk/NACEB'
import type { TaskInstance } from '@chenyfan/nasdk/NACEB'
import { z } from 'zod'

class GreetingTask extends TaskHandler<string> { // [!code focus:11]
  readonly name = 'greet'
  readonly payloadSchema = z.object({ name: z.string() })

  async execute(this: TaskInstance) {
    const { name } = this.input as { name: string }
    this.processingResultReport({ stage: 'greeting' })
    return `Hello, ${name}!`
  }
}
```

:::danger

`execute()` 的 `this` 绑定在 [TaskInstance](../processing/task#taskinstance)，而不是 `TaskHandler`。

| 成员                                 | 作用                             |
| ------------------------------------ | -------------------------------- |
| `this.input`                         | Pipeline 为本步提供的输入        |
| `this.state`                         | 本次 Task 执行期间的状态空间     |
| `this.pipeline.state`                | Pipeline 共享的状态空间          |
| `this.abortSignal`                   | 协商终止当前执行的 `AbortSignal` |
| `this.processingResultReport(chunk)` | 上报一条过程消息                 |

因此 `execute()` 和 `onSignal()` 应使用普通方法，不应使用箭头函数。

也就是说，Handler内对this的篡改不会影响到Handler本身，而是影响到对应实例的状态。这一点和[PipelineHandler](./pipeline-handler)一致

暂停、恢复与协商终止见[生命周期](../lifecycle#暂停与恢复)。

:::

## 注册

在构造 NACEB 时传入实例：

```ts
const naceb = new NACEB({
  pipelineHandlers: [],
  taskHandlers: [new GreetingTask()], // [!code focus]
})
```

也可以在构造后注册：

```ts
naceb.registerTaskHandler(new GreetingTask())
```

:::danger
`$` 前缀保留给[内建任务](../builtins/)，不能用于自定义 Handler。
:::
