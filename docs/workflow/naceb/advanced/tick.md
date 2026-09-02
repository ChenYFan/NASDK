# 刻

刻（tick）是NACEB协调三个FSMController的统一推进机制，负责队列调度与层间状态同步。

各层在一刻中的具体动作见[Task](../processing/task#调度)、[Pipeline](../processing/pipeline#调度)与[Event](../processing/event#调度)。

## 刻发生

刻可以由以下来源激活：

| 来源           | 时机                                          |
| -------------- | --------------------------------------------- |
| 基础时钟       | 每50ms调用一次                                |
| `start()`      | Event离开`idle`后                             |
| `resume()`     | Event离开`paused`后                           |
| Task收尾       | `execute()`进入`done`、`failure`或`stopped`后 |
| Task停止或重启 | Task进入`stopped`或重新进入`pending`后        |
| 快进刻         | 上一刻报告发生推进后                          |

`alertTick()`执行期间会自锁。此时到达的其他激活请求会被丢弃，不会排队累积。

### 基础时钟

`ensureClock()`确保全局只存在一个50ms定时器。

定时器每次触发时先通过`EventFSMController.hasLive()`判断是否仍需运行：

| Event状态                                                 | 保持时钟 | 原因                          |
| --------------------------------------------------------- | -------- | ----------------------------- |
| `idle`、`paused`                                          | 否       | 等待外部`start()`或`resume()` |
| `blocked`、`queue`、`activating`、`processing`、`pending` | 是       | 仍需调度或同步                |
| `done`、`failure`，未启用`bypassConsume`                  | 是       | 等待外部消费                  |
| `done`、`failure`，启用`bypassConsume`                    | 否       | Event层会自动消费             |

没有需要保持时钟的Event时，定时器会停止。之后创建Event、调用`start()`或`resume()`会再次执行`ensureClock()`。

:::warning
未消费的普通终局Event会持续保持基础时钟运行。

若不需要取得结果，应使用自动消费机制。
:::

### 快进刻

三个Controller中任意一个报告本刻发生推进时，NACEB会通过`setTimeout(..., 0)`立即激活下一刻。

因此50ms只是基础时钟的兜底间隔，不是状态转移的最小间隔。
:::tip
队列持续可推进时，NACEB会通过快进刻连续运行。

Controller报告的`moved`表示本刻完成了一次推进尝试，不严格等同于状态值发生改变。

被`VetoT`否决的可重试转移也会触发快进刻，使下一刻重新计算条件。
:::

## 刻发生时

`alertTick()`激活一刻，并按固定顺序等待三个Controller：

```text
TaskFSMController.nextTick()
  → PipelineFSMController.nextTick()
    → EventFSMController.nextTick()
```

顺序从下层到上层，使下层已经产生的结果可以在同一刻继续向上传递。

## 注意

Hook会被`nextTick()`等待，因此耗时Hook会阻塞当前刻。

纯观测应使用[EventBus](./observability/event)。
