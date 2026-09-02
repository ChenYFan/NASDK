# EventAlias

EventAlias将Event名称映射到已注册的 [PipelineHandler](./pipeline-handler)，使调用方不需要了解内部Pipeline名称。

## 接口

```ts
interface EventAlias {
  eventName: string
  pipelineName: string
  description: string
}
```

## 定义Alias

```ts
import type { EventAlias } from '@chenyfan/nasdk/NACEB'

const alias: EventAlias = {
  eventName: 'GreetingEvent',
  pipelineName: 'greeting',
  description: '生成问候语',
}
```

多个Event名称可以映射到同一个Pipeline。

## 注册

在构造NACEB时传入：

```ts
const naceb = new NACEB({
  pipelineHandlers: [],
  taskHandlers: [],
  eventAlias: [alias], // [!code focus]
})
```

也可以在构造后注册：

```ts
naceb.registerEventAlias(alias)
```

`listEventAlias()`返回Event名称与描述，供[EventProcessor](/workflow/processor/event-processor)声明可处理的Event。
