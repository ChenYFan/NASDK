# 构造一个 NACEB

```ts
import { NACEB } from '@chenyfan/nasdk/NACEB'
import type {
  EventAlias,
  PipelineHandler,
  TaskHandler,
} from '@chenyfan/nasdk/NACEB'

const naceb = new NACEB({ // [!code focus:5]
  pipelineHandlers: PipelineHandler[],
  taskHandlers: TaskHandler[],
  eventAlias?: EventAlias[],
})
```

| 参数               | 说明                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `pipelineHandlers` | 可用的 [PipelineHandler](./registration/pipeline-handler)                         |
| `taskHandlers`     | 可用的 [TaskHandler](./registration/task-handler)                                 |
| `eventAlias`       | 可选，将 Event 名称映射到 Pipeline，详见 [EventAlias](./registration/event-alias) |

Handler 和 EventAlias 也可以在构造后通过 `registerPipelineHandler()`、`registerTaskHandler()` 与 `registerEventAlias()` 注册。

## 示例

下面的 NACEB 接收 `GreetingEvent`，执行 `greet` Task，并通过 `$terminal` 返回结果：

```js
import {
  NACEB,
  PipelineHandler,
  TaskHandler,
} from '@chenyfan/nasdk/NACEB'

class GreetingPipeline extends PipelineHandler { // [!code focus:29]
  name = 'greeting'
  description = '生成问候语'

  next(lastResult) {
    if (lastResult === undefined) {
      return { task: 'greet', input: this.event.payload }
    }
    return { task: '$terminal', input: lastResult }
  }
}

class GreetingTask extends TaskHandler {
  name = 'greet'

  async execute() {
    return `Hello, ${this.input.name}!`
  }
}

const naceb = new NACEB({
  pipelineHandlers: [new GreetingPipeline()],
  taskHandlers: [new GreetingTask()],
  eventAlias: [{
    eventName: 'GreetingEvent',
    pipelineName: 'greeting',
    description: '生成问候语',
  }],
})
```

## 运行 Event

`pushEvent()` 将返回 Event ID。

新 Event 默认状态保持在 `idle`，需要调用 `start()` 后方可开始运行：

```js
const eventId = naceb.pushEvent({
  name: 'GreetingEvent',
  payload: { name: 'Nyirusu' },
})

const event = naceb.getEvent(eventId)
event.afterTDone(function () {
  console.log(this.consume()) // Hello, Nyirusu!
})

await event.start()
```

Event 的输入、控制与消费方式参见 [Event](./processing/event)，状态变化参见 [生命周期](./lifecycle)。
