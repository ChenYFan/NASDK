# PipelineHandler

PipelineHandler允许外部编排 [TaskHandler](./task-handler)，根据上一轮结果和状态派发下一个Task。

[PipelineInstance](../processing/pipeline) 执行期间会绑定对应的PipelineHandler。

## 接口

```ts
abstract class PipelineHandler {
  abstract readonly name: string
  readonly description?: string
  abstract next(this: any, lastResult: unknown): PipelineStep | undefined
  onNormalSIG?(this: any, signal: NormalSignal): void | Promise<void>
}
```

| 成员            | 作用                           |
| --------------- | ------------------------------ |
| `name`          | Event选择Pipeline时使用的名称  |
| `description`   | Pipeline的用途说明             |
| `next()`        | 根据上一个Task的结果派发下一步 |
| `onNormalSIG()` | 接收发给当前Event的普通信号    |

`next()`返回一个`PipelineStep`：

```ts
interface PipelineStep {
  task: string
  input: unknown
}
```

`task`对应已注册的[TaskHandler](./task-handler)，`input`会成为该TaskInstance的输入。

## 定义 Handler

```ts
import { PipelineHandler } from '@chenyfan/nasdk/NACEB'
import type { PipelineInstance } from '@chenyfan/nasdk/NACEB'

class GreetingPipeline extends PipelineHandler { // [!code focus:17]
  readonly name = 'greeting'
  readonly description = '生成问候语'

  next(this: PipelineInstance, lastResult: unknown) {
    if (!this.state.started) {
      this.state.started = true
      return {
        task: 'greet',
        input: this.event.payload,
      }
    }

    return { task: '$terminal', input: lastResult }
  }
}
```

:::tip
Pipeline第一次运行时，`lastResult`为`undefined`，此后是上一个Task的返回值。

由于Task也可能返回`undefined`，需要区分步骤时应使用`this.state`记录。
:::

:::danger
`next()`和`onNormalSIG()`的`this`绑定在[PipelineInstance](../processing/pipeline#pipelineinstance)，而不是`PipelineHandler`。

| 成员                | 作用                            |
| ------------------- | ------------------------------- |
| `this.event`        | 当前Pipeline处理的EventInstance |
| `this.state`        | 跨Task步骤共享的状态空间        |
| `this.getTask()`    | 获取当前TaskInstance            |
| `this.signalTask()` | 将信号继续发送给当前Task        |

因此`next()`和`onNormalSIG()`应使用普通方法，不应使用箭头函数。

Handler内对`this`的修改是在对应实例上完成的，并不会修改Handler本身。这一点和[TaskHandler](./task-handler)一致。
:::

## 结束 Pipeline

Pipeline必须派发 [`$terminal`](../builtins/terminal) 任务才能视为正常完成：

```ts
return { task: '$terminal', input: finalResult }
```

`$terminal`的输入就是Pipeline最终结果。

## 普通信号

普通信号会先交给`onNormalSIG()`，不会立刻传给当前Task，信号入口见[Event层](../processing/event)。

```ts
async onNormalSIG(this: PipelineInstance, signal: NormalSignal) {
  await this.signalTask(signal)
}
```

## 注册

在构造NACEB时传入实例：

```ts
const naceb = new NACEB({
  pipelineHandlers: [new GreetingPipeline()], // [!code focus]
  taskHandlers: [],
})
```

也可以在构造后注册：

```ts
naceb.registerPipelineHandler(new GreetingPipeline())
```
