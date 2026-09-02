# NACEB API

## 注册

| 方法 | 说明 |
| --- | --- |
| `registerPipelineHandler(handler)` | 注册一个 [PipelineHandler](./registration/pipeline-handler) |
| `registerTaskHandler(handler)` | 注册一个 [TaskHandler](./registration/task-handler) |
| `registerEventAlias(alias)` | 注册一个 [EventAlias](./registration/event-alias) |

## Event

| 方法 | 说明 |
| --- | --- |
| `pushEvent(input, opts?)` | 创建 Event，返回 Event ID |
| `getEvent(id)` | 获取 EventInstance，不存在时返回 `null` |
| `listEvent()` | 列出当前 Event |
| `consumeEvent(id)` | 消费终局 Event 并返回结果 |
| `listEventAlias()` | 返回可声明的 Event 名称与描述 |

Event 的字段、选项和控制方法参见 [Event](./processing/event)。

## 接入与观测

| 成员 | 说明 |
| --- | --- |
| `nacpAdaptor` | [EventProcessor](/workflow/processor/event-processor) 接口实现 |
| `eventBusObs` | NACEB EventBus 的只读订阅入口 |
| `on(hook, callback)` | 注册 `beforePushEvent` 或 `afterPushEvent` |

状态转移 Hook 与运行事件分别参见 [Hook](./advanced/observability/hook) 和 [Event](./advanced/observability/event)。
