# NApp 可观测

NApp 自身的运行事件使用 `napp:` 命名空间，并通过 `app.bus` 发布。

```js
const listenerId = app.bus.listen("napp:internal:*:*", (payload, hitKey) => {
  console.log(hitKey, payload)
})
```

:::info
NApp的总线同时还被内置NACP、NACT共同使用。

本章只阐述NApp自身的事件
:::

## NotifyStream 溢出

```text
napp:internal:notify:warning
```

Event Request 或 Subscribe 的迭代器来不及消费消息，且缓冲数量超过 `queueMaxCount` 时，NApp 会丢弃最旧的一条消息并发布该事件。

```js
app.bus.listen(
  "napp:internal:notify:warning",
  ({ appId, subId, targetSubName, dropped, reason }) => {
    console.warn(appId, subId, targetSubName, dropped, reason)
  },
)
```

| 字段            | 说明                                              |
| --------------- | ------------------------------------------------- |
| `appId`         | 该消息流对应的远端 NApp                           |
| `subId`         | Subscribe 的订阅 ID；Event Request 中等于 `reqId` |
| `targetSubName` | 对应的远端 EventBus 事件名                        |
| `dropped`       | 被丢弃的完整 `NotifyMessage`                      |
| `reason`        | 固定为 `"stream-overflow"`                        |

:::warning
只有迭代器使用 `NotifyStream` 缓冲队列。回调没有该队列，因此回调本身不会触发此溢出事件。
:::

## 事件表

| key                            | 触发时机                          |
| ------------------------------ | --------------------------------- |
| `napp:internal:notify:warning` | NotifyStream 溢出并丢弃最旧消息时 |
