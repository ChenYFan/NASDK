# 可观测 Event

NACEB通过独立的EventBus广播状态转移和运行时消息。

外部使用`naceb.eventBusObs`监听。该接口可以挂载和取消Listener，但不能发送Event。

```ts
const listenerId = naceb.eventBusObs.listen(key, listener)
naceb.eventBusObs.off(listenerId)
```

## 监听

`listen()`返回独立的Listener ID。回调的第二个参数是实际命中的完整key：

```ts
const listenerId = naceb.eventBusObs.listen(
  'naceb:runtime:log:*',
  (payload, hitKey) => {
    console.log(hitKey, payload)
  },
)

naceb.eventBusObs.off(listenerId)
```

也可使用`listenOnce()`监听一次，或使用`asyncListenOnce()`等待一次Event。

`*`只匹配一个由冒号分隔的片段。例如`naceb:task:*:after:*`可以监听所有Task的after TEvent。

EventBus的通配符、单次监听和等待接口见[EventBus API](/napp/eventbus/bus)。

## TEvent

> TEvent 和 THook类似，T代表的是状态转移（Transition）。

```js
naceb:{layer}:{state}:{phase}:{id}
```

| 片段    | 取值                        |
| ------- | --------------------------- |
| `layer` | `event`、`pipeline`或`task` |
| `state` | 本次转移的目标状态          |
| `phase` | `before`或`after`           |
| `id`    | 对应Instance ID             |

TEvent的payload恒为`undefined`。Listener的`this`是对应Instance的浅层只读视图：

```ts
naceb.eventBusObs.listen(
  'naceb:task:done:after:*',
  function (this: TaskInstance, _, hitKey) {
    console.log(hitKey, this.id, this.response?.result)
  },
)
```

### before 与 after

| 阶段     | Listener看到的状态 | 转移副作用 |
| -------- | ------------------ | ---------- |
| `before` | 原状态             | 尚未执行   |
| `after`  | 目标状态           | 已完成     |

:::tip
NACEB先广播TEvent，再运行同名[THook](./hook)。

因此before TEvent看不到随后Hook对Instance的修改，after TEvent也先于after Hook。
:::

:::warning
Pipeline的`running → running`同态转移同样会广播before与after TEvent。
:::

各层状态对应的完整THook与TEvent清单见[Hook](./hook#thook)。

## Runtime Event

Runtime Event描述状态转移之外的运行信息：

```js
naceb:runtime:{level}:{id}
```

Runtime Event的Payload统一以下格式：

```ts
interface RuntimePayload {
  layer: string
  id: string
  msg?: string
  opt?: Record<string, unknown>
}
```

Runtime Event不绑定Instance到`this`，所有信息均从payload读取。

| level     | 用途                                      | 常见`opt`                                  |
| --------- | ----------------------------------------- | ------------------------------------------ |
| `log`     | Instance创建、消费和状态转移              | `from`、`to`、`same`、`name`               |
| `warning` | Veto、暂停或恢复未推进等可恢复情况        | `reason`、`veto`、`op`                     |
| `error`   | Hook错误、停止超时和EventBus Listener错误 | `error`、`at`、`reason`                    |
| `message` | Task上报过程消息                          | `taskId`、`eventId`、`pipelineId`、`chunk` |
| `signal`  | NACPAdaptor向Event投递信号                | `signalId`、`reqId`、`kind`、`payload`     |

### 过程消息

`TaskInstance.processingResultReport(chunk)`会广播：

```js
naceb:runtime:message:{eventId}
```

```ts
const listenerId = naceb.eventBusObs.listen(
  `naceb:runtime:message:${eventId}`,
  payload => console.log(payload.opt?.chunk),
)
```

NACEB的NACPAdaptor使用同一Event将过程消息交给Processor的`onProcess`。

### 信号

通过NACPAdaptor投递的普通、暂停、恢复和中止信号会先广播：

```text
naceb:runtime:signal:{eventId}
```

:::tip
直接调用EventInstance的控制方法不会产生这条Runtime Event。
:::

## 分发与错误

EventBus会同步调用当前匹配的Listener，但不会等待Listener返回的Promise。

因此Listener不参与NACEB的状态转移控制，也不能替代Hook。

Listener抛错或返回rejected Promise时，异常不会中断其他Listener或状态转移，而会转为：

```text
naceb:runtime:error:bus
```

其payload包含触发错误的`key`与`error`。

:::info
同一key挂载超过50个Listener时，也会通过该Event报告可能的监听泄漏。
:::
