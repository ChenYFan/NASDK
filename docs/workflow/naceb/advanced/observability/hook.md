# Hook

Hook是NACEB提供的同步介入机制。

Hook在状态转移前后发生，并会阻塞当前调用链和[刻](../tick)。

THook是NACEB Hook的一个子类，只会在Transition状态转移时出现。

:::tip
只需要观测运行时事件时，应使用[EventBus](./event)。

需要读取或修改Instance、阻止特定转移时才使用Hook。
:::

## 挂载

Hook以普通函数注册，回调的`this`绑定到对应的原始Instance：

```ts
const event = naceb.getEvent(eventId)!

event.beforeTQueue(function () {
  console.log(this.id)
})

event.afterTDone(function () {
  console.log(this.final)
})
```

:::warning
不要使用箭头函数。箭头函数不会接收NACEB绑定的`this`。
:::

同一转移可以挂载多个Hook，NACEB按挂载顺序依次调用。

挂载方法返回当前Instance，可以继续链式挂载：

```ts
event
  .beforeTQueue(function () {})
  .afterTDone(function () {})
```

Event Hook也可在Event启动前预先传入，详见[构造一个NACEB](../../construction)。

:::tip
默认情况下没有`byPassIdle`的任务都能先挂上监听再进行。
:::

## 可观测Event

每个THook都有一个同目标状态、同阶段的[TEvent](./event#t-事件转移事件)：

| Hook                         | TEvent                              |
| ---------------------------- | ----------------------------------- |
| `event.beforeTQueue(fn)`     | `naceb:event:queue:before:{id}`     |
| `pipeline.afterTRunning(fn)` | `naceb:pipeline:running:after:{id}` |
| `task.afterTDone(fn)`        | `naceb:task:done:after:{id}`        |

发生转移时，NACEB总是先广播TEvent，再执行对应Hook。

:::warning
因此TEvent Listener看到的是该阶段开始时的Instance，不能依赖随后Hook造成的修改。
:::

|              | Hook                      | TEvent Listener                         |
| ------------ | ------------------------- | --------------------------------------- |
| 挂载对象     | 单个Instance              | `naceb.eventBusObs`                     |
| 作用范围     | 当前Instance              | 可按ID精确监听，也可用`*`跨Instance监听 |
| `this`       | 原始Instance              | Instance的浅层只读视图                  |
| 是否阻塞转移 | 是，异步Hook会被等待      | 否，异步Listener不会被等待              |
| 异常         | 可导致Veto或本层`failure` | 隔离并上报，不影响转移                  |
| 用途         | 介入状态转移              | 观测状态转移                            |

```ts
const listenerId = naceb.eventBusObs.listen(
  'naceb:event:done:after:*',
  function (_, hitKey) {
    console.log(hitKey, this.final)
  },
)
```

## 取消

当前Instance Hook没有单独取消API。挂载方法不返回 disposer，也不能按函数移除。Hook随所属Instance被消费而释放。

TEvent监听则可使用`listenOnce()`只监听一次，或使用`listen()`返回的Listener ID取消：

```ts
const listenerId = naceb.eventBusObs.listen(key, listener)
naceb.eventBusObs.off(listenerId)
```

需要主动取消时，应使用TEvent监听，而不是Hook。

## 转移时序

每次状态转移均遵循相同顺序：

```text
广播 before TEvent
  → 依次 await before Hook
  → 执行转移副作用
  → 更新 status
  → 广播 after TEvent
  → 依次 await after Hook
```

转移副作用包括创建下层Instance、保存结果或消费下层Instance。因此，before与after看到的对象可能不同。

| 阶段             | 状态                             | 异常行为                              |
| ---------------- | -------------------------------- | ------------------------------------- |
| `beforeT{State}` | 仍是原状态，转移副作用尚未执行   | 交给当前层处理，可触发Veto或`failure` |
| `afterT{State}`  | 已进入目标状态，转移副作用已完成 | 只上报错误，不回滚转移                |

Hook中的`this`是原始Instance，可以调用方法和修改可写字段。状态字段由NACEB维护，不应直接修改；需要否决转移时使用[Veto](./hook/veto)。

## THook

### Event Hook

| 目标状态     | Hook                                         |
| ------------ | -------------------------------------------- |
| `blocked`    | `beforeTBlocked()` / `afterTBlocked()`       |
| `queue`      | `beforeTQueue()` / `afterTQueue()`           |
| `activating` | `beforeTActivating()` / `afterTActivating()` |
| `processing` | `beforeTProcessing()` / `afterTProcessing()` |
| `pending`    | `beforeTPending()` / `afterTPending()`       |
| `paused`     | `beforeTPaused()` / `afterTPaused()`         |
| `done`       | `beforeTDone()` / `afterTDone()`             |
| `failure`    | `beforeTFailure()` / `afterTFailure()`       |

:::tip
`afterTActivating()`运行时PipelineInstance已经创建，可通过`this.getPipeline()`取得并注册Pipeline Hook。
:::

Event进入`done`或`failure`时，Pipeline在before Hook之后被消费，此时`beforeTDone()`与`beforeTFailure()`仍可读取Pipeline，after Hook则读取已经写入`this.final`的结果。

### Pipeline Hook

| 目标状态  | Hook                                   |
| --------- | -------------------------------------- |
| `pending` | `beforeTPending()` / `afterTPending()` |
| `running` | `beforeTRunning()` / `afterTRunning()` |
| `paused`  | `beforeTPaused()` / `afterTPaused()`   |
| `done`    | `beforeTDone()` / `afterTDone()`       |
| `failure` | `beforeTFailure()` / `afterTFailure()` |

:::tip
PipelineInstance创建时直接处于`pending`，当前实现不会为初始状态触发`TPending`。

TaskInstance在Pipeline转为`running`的副作用中创建。因此，`afterTRunning()`运行时可通过`this.getTask()`取得TaskInstance并注册Task Hook。

Pipeline派发后续Task时会发生`running → running`同态转移，before与after Hook仍会正常触发。

Pipeline层没有可否决点，任何before Hook抛错都会使Pipeline进入`failure`。
:::

### Task Hook

TaskInstance提供以下Hook：

| 目标状态  | Hook                                   |
| --------- | -------------------------------------- |
| `pending` | `beforeTPending()` / `afterTPending()` |
| `running` | `beforeTRunning()` / `afterTRunning()` |
| `done`    | `beforeTDone()` / `afterTDone()`       |
| `stopped` | `beforeTStopped()` / `afterTStopped()` |
| `failure` | `beforeTFailure()` / `afterTFailure()` |

:::tip
TaskInstance首次创建时直接处于`pending`，不会触发`TPending`。暂停后的`stopped → pending`恢复会触发。

`beforeTRunning()`发生在调用`TaskHandler.execute()`之前，是Task层唯一可否决点。`afterTRunning()`完成后才会开始执行Handler。

:::

## 其它Hook

NACEB还提供两个创建入口Hook，它们不属于状态转移Hook：

| Hook              | 时机                                                  |
| ----------------- | ----------------------------------------------------- |
| `beforePushEvent` | EventInstance创建前，可返回`{ reject: true }`拒绝创建 |
| `afterPushEvent`  | EventInstance创建并入队后                             |

通过`naceb.on(name, fn)`挂载。它们接收完整的EventInterface参数，`this`不绑定Instance。

每种NACEB Hook只保存一个回调。重复调用`naceb.on()`会覆盖同名回调。
