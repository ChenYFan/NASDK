# EventBus

EventBus 是 NASDK 的进程内事件总线，用于在模块之间发布和监听事件。

EventBus 不与 NApp 绑定，可以作为独立组件直接使用：

```js
import { EventBus } from "@chenyfan/nasdk"

const bus = new EventBus()

const listenerId = bus.listen("task:done", (payload) => {
  console.log(payload)
})

bus.emit("task:done", { result: 42 })
bus.off(listenerId)
```

:::tip
NApp 本质上是 EventBus 的对外版本，NASDK 的大部分设计都围绕 EventBus 底层消息管线展开。

甚至，应用可以不使用 `NApp.request` 等任务调用能力，直接通过 `app.bus.emit()` 发布消息。

并允许本地 `app.bus.listen()` 或 让其他 NApp 通过 `NApp.subscribe` 远程订阅这些消息。
:::

NApp以及内部 NACP 和 NACT 使用这个 Bus 发布业务事件、消息流转和生命周期信息。

NACEB、NACAB 等组件也有各自独立的 EventBus，不复用 `app.bus`。

## 进程内与远程

`emit()` 只在当前 EventBus 实例内分发事件，不会自行发送到其他 NApp。

:::tip
但是，如果其他NApp订阅了这条消息，还是会发送给远程NApp。
:::

[`subscribe()`](./abilities/subscribe) 用于订阅远端 NApp 的 EventBus。

订阅建立后，远端的匹配事件会被 NACP 转换为 `NotifyMessage` 并发送给订阅方：

```text
远端 EventBus.emit()
  → NACP
  → NotifyMessage
  → 本地 callback / stream
```

:::warning
因此，正常业务应先在本地 EventBus 上 `emit()`。

直接调用 [`notify()`](./abilities/notify) 不会发布 `hitSubName` 对应的业务事件，因此不会触发该业务事件的本地 Listener。
:::

标准 NACP 消息出站时，会在 `app.bus` 上发布 `nacp:outbound:<type>` 观测事件。

:::danger

标准NACP事件可在[NACP](/transport/nacp)查看，请注意，`ack`、`notify`和`response`也是标准NACP消息。

因此，如果你尝试订阅`nacp:outbound:notify:*`，很有可能会导致订阅到即将激活这个监听器的订阅内容，造成`消息自激`，最终形成`消息海啸`。

截止`NASDK 1.0.3`，本特性是已知并且暂时标记为`刻意为之的`。
:::

## 事件名

事件名使用 `:` 分段：

```text
task:done
task:failed
nacp:internal:notify:warning
```

监听时可以使用单段通配符 `*`：

```js
app.bus.listen("task:*", (payload, hitKey) => {
  console.log(hitKey, payload)
})
```

`task:*` 可以匹配 `task:done`，但不能匹配 `task:step:done`。EventBus 不支持 `**` 多段通配符。

完整方法见 [EventBus API](./eventbus/bus)。各事件字段分别见 [NApp 可观测](./advanced/observability)、[NACP 可观测](/transport/nacp/observability) 和 [NACT 可观测](/transport/nact/observability)。
