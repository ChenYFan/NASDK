# NACEB 生命周期

NACEB 有三层状态机，每层都具有自己的FSMController。

本章仅用于介绍所有的状态机与迁移状态，具体触发迁移详情请参考事件处理部分。

## Event 层

```mermaid
flowchart TD
    START((*)) -->|pushEvent| idle
    idle -->|start 且有 blockedBy| blocked
    idle -->|start 且无 blockedBy| queue
    blocked -->|前置都终局或不存在| queue
    queue -->|同 scope 无占用| activating
    activating -->|当前 task 是 blocked| processing
    activating -->|当前 task 是 async| pending
    processing -->|换成 async task| pending
    pending -->|换成 blocked task| processing
    processing -->|Event.pause| paused
    pending -->|Event.pause| paused
    paused -->|resume（blocked）| processing
    paused -->|resume（async）| pending
    processing -->|pipeline done| done([done])
    pending -->|pipeline done| done
    processing -->|pipeline failure| failure([failure])
    pending -->|pipeline failure| failure
```

| 状态名       | 含义                           | 从何而来                                              | 到哪里去                                                  |
| ------------ | ------------------------------ | ----------------------------------------------------- | --------------------------------------------------------- |
| `idle`       | Event 创建时默认状态           | `pushEvent()`                                         | `start()` 后<br/>进入`blocked`/`queue`                    |
| `blocked`    | Event 被前置事件阻塞           | `start()`时带有 `blockedBy` 参数                      | 前置 Event 不再阻塞时<br/>进入`queue`                     |
| `queue`      | Event 已就绪，等待执行         | `start()`后<br/>或`blocked`结束                       | 同 scope 无 Event竞争<br>进入`activating`                 |
| `activating` | Event 激活中，准备运行         | `queue`结束                                           | 根据第一步任务类型<br>进入 `processing`或`pending`        |
| `processing` | Pipeline 当前运行 blocked Task | `activating`、`pending`、`paused`                     | 根据下一步进入`pending`、`processing`或`pause`、终态      |
| `pending`    | Pipeline 当前运行 async Task   | `activating`、`pending`、`paused`                     | 根据下一步进入`pending`、`processing`或`pause`、终态      |
| `paused`     | Event 对应 Pipeline 暂停       | 对 Event 调用 `pause()`                               | `resume()` 后根据任务类型<br>进入 `processing`或`pending` |
| `done`       | Event 正常结束，终态           | `processing` 或 `pending` 对应的 Pipeline 进入 `done` | -                                                         |
| `failure`    | Event 异常结束，终态           | 任意状态发生失败均可直接进入                          | -                                                         |

## Pipeline 层

```mermaid
flowchart TD
    START((*)) -->|Event activating 副作用| pending
    pending -->|next 派下一个 task| running
    running -->|next 派下一个 task（同态）| running
    running -->|task stopped| paused
    running -->|$terminal task done| done([done])
    running -->|task failure 或 next 异常| failure([failure])
    paused -->|resume| running
```

| 状态名    | 含义                        | 从何而来                       | 到哪里去                                  |
| --------- | --------------------------- | ------------------------------ | ----------------------------------------- |
| `pending` | Pipeline 创建时默认状态     | Event 进入 `activating`        | 派发 Task 后进入 `running`                |
| `running` | Pipeline 当前已有 Task 运行 | `pending`、`running`、`paused` | 根据下一步进入 `running`、`paused` 或终态 |
| `paused`  | Pipeline 暂停               | Task 进入 `stopped`            | `resume()` 后进入 `running`               |
| `done`    | Pipeline 正常结束，终态     | `$terminal` Task 完成          | -                                         |
| `failure` | Pipeline 异常结束，终态     | 任意状态发生失败均可直接进入   | -                                         |

## Task 层

```mermaid
flowchart TD
    START((*)) -->|TaskFSMController.dispatch| pending
    pending -->|放行| running
    pending -->|未放行即被 pause 打断| stopped
    running -->|正常 return| done([done])
    running -->|abort 中断，提前收尾| stopped
    running -->|execute throw| failure([failure])
    stopped -->|restart 重启| pending
```

| 状态名    | 含义                    | 从何而来                           | 到哪里去                                                          |
| --------- | ----------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `pending` | Task 已派发，等待执行   | `dispatch()`<br/>或 `stopped` 重启 | 条件满足后进入 `running`<br/>暂停时进入 `stopped`                 |
| `running` | TaskHandler 执行中      | `pending`                          | 正常结束进入 `done`<br/>暂停进入 `stopped`<br/>异常进入 `failure` |
| `stopped` | Task 已暂停，可重新启动 | `pending` 或 `running` 时暂停      | `restart()` 后进入 `pending`                                      |
| `done`    | Task 正常结束，终态     | TaskHandler 正常返回               | -                                                                 |
| `failure` | Task 异常结束，终态     | 任意状态发生失败均可直接进入       | -                                                                 |

:::info
重启后 Instance 会保留，同时保留所有的 hook 和 state，便于内部重建。
:::

## 消费

所有队列在进入 done 或 failure 后都不会自己被清除。

NACEB 对完成的实例没有「清除」概念，取而代之的是「消费」。

「消费 Consume」的含义是：取走这个实例的结果，并清空结果输出，标记这个结果被「消费掉了」。

:::warning
对非终态 event 进行 `consumeEvent` 将直接抛错，这是为了防止误清还在运行的 event。
:::

## 暂停与恢复

```mermaid
sequenceDiagram
    participant Caller as 调用方
    participant Event as Event Instance
    participant Pipeline as Pipeline Instance
    participant Task as Task Instance
    participant TaskHandler

    Caller->>Event: pause()
    Event->>Event: → paused
    Event->>Pipeline: _pause()
    Pipeline->>Pipeline: → paused
    Pipeline->>Task: _stop()
    Task->>Task: AbortController.abort()
    Task->>TaskHandler: onSignal(abort)
    TaskHandler-->>Task: execute() 结束
    Task->>Task: → stopped
    Task-->>Pipeline: 终止结果
    Pipeline->>Pipeline: → paused
    Pipeline-->>Event: 暂停结果
    Event-->>Event: → paused

    Event-->>Caller: 暂停结果

    Note over Caller,TaskHandler: 恢复
    Caller->>Event: resume()
    Event->>Pipeline: _resume()
    Pipeline->>Task: _restart()
    Task->>TaskHandler: 重置AbortController
    Task->>Task: → pending
    Task-->>Pipeline: 重启完成
    Pipeline->>Pipeline: paused → running
    Pipeline-->>Event: 恢复结果
    Event->>Event: → processing / pending
    Event-->>Caller: 恢复结果

    Note over Task,TaskHandler: Next Tick
    Task->>Task: pending → running
    Task->>TaskHandler: execute()
```
