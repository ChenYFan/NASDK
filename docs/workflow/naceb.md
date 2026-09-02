# NACEB

NACEB 全称 Nyirusu Application Control Event Bus，是 NASDK 默认的**事件处理器**。

NACEB 承担一个事件进入后交付的事件处理流水线，并负责事件处理时消息上报和信号注入。

也正因如此，NACEB很适合处理需要多个步骤、可能持续较长时间，并且需要协调有限资源的事件。

NACEB 通常作为 NACP Event Request 的处理端，通过 [Event Processor](/workflow/processor/event-processor) 接入 NApp。

:::tip
需要发布和订阅普通消息时，应使用 [EventBus](/napp/eventbus)。

需要执行一次调用、一次返回的能力时，应使用 [NACAB](/workflow/nacab)。
:::

## 构成

NACEB 将一次事件处理拆成三层：

- **Event** 表示一次待处理事件。
- **Pipeline** 决定事件接下来交给哪个 Task。
- **Task** 执行一个具体步骤。

其中，具体的设计如下所示

```js
NACEB
├── eventBus: EventBus
├── pipelineHandlers: Map<PipelineName, PipelineHandler>
├── taskHandlers: Map<TaskName, TaskHandler>
├── eventAlias: Map<EventName, EventAlias>
├── taskController: TaskFSMController
│   ├── blockedQueue: Map<busyKey, TaskInstance[]>
│   └── asyncQueue: TaskInstance[]
├── pipelineController: PipelineFSMController
│   └── queue: PipelineInstance[]
└── eventController: EventFSMController
    └── queue: EventInstance[]
```

NACEB 顶层持有 EventBus，以及 PipelineHandler、TaskHandler 和 EventAlias 三张注册表。

EventAlias 将外部事件名映射到 Pipeline，两个 Handler 分别定义流水线和任务的处理逻辑。

Controller 之间可以查询彼此，但状态转移只由拥有该 Instance 的 Controller 执行。

Handler 会在多次运行间复用，因此不保存单次运行状态。

每次 Event、Pipeline 和 Task 的输入、状态与结果都保存在对应的 Instance 中。

## 更多

- 创建并运行第一个 NACEB：[构造一个 NACEB](/workflow/naceb/construction)
- NACEB 的顶层公开入口：[NACEB API](/workflow/naceb/api)
- Event、Pipeline 与 Task 的状态变化：[生命周期](/workflow/naceb/lifecycle)
- Handler 与事件别名：[TaskHandler](/workflow/naceb/registration/task-handler)、[PipelineHandler](/workflow/naceb/registration/pipeline-handler)、[EventAlias](/workflow/naceb/registration/event-alias)
- 三层各自的职责：[Event](/workflow/naceb/processing/event)、[Pipeline](/workflow/naceb/processing/pipeline)、[Task](/workflow/naceb/processing/task)
- 资源等待与统一推进：[tick](/workflow/naceb/advanced/tick)
- 观察和干预状态变化：[Hook](/workflow/naceb/advanced/observability/hook)、[可观测事件](/workflow/naceb/advanced/observability/event)
