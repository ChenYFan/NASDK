# AutoSubscribe

AutoSubscribe 是 Event Request 的过程流订阅机制。

调用 `request({ kind: "event" })` 时，NACP 会自动为该请求建立一条临时订阅，用于把 Processor 产生的过程结果发送给请求方：

```text
Event Request
  → 自动建立 Process 订阅
  → 0..N 条 NotifyMessage
  → 最终 Response
  → 自动解除订阅
```

业务方不需要额外调用 `subscribe()` 或 `unsubscribe()`。

## 订阅目标

每个 Event Request 使用自己的 `reqId` 作为订阅 ID：

```text
subId = reqId
targetSubName = nacp:event:<reqId>:process
```

因此，并发 Event Request 的过程消息不会相互混淆。

Processor 上报过程结果后，接收方会在对应事件名上发布消息，NACP 再将其转换为标准 `NotifyMessage`：

```js
const call = app.request("worker", {
  kind: "event",
  target: "run",
  onProcess: (message) => console.log(message.payload),
})

for await (const message of call.stream) {
  console.log(message.payload)
}
```

回调与迭代器收到同一批过程消息。具体载荷与缓存语义见 [`request()`](/napp/abilities/request) 和 [`subscribe()`](/napp/abilities/subscribe)。

## 虚拟订阅

AutoSubscribe 不会在网络上额外发送 `subscribe` 或 `unsubscribe` 消息。

请求方在 Request 出站前建立本地接收记录；响应方收到 Request 时建立远端 EventBus Listener。两端已通过同一个 `reqId` 知道订阅身份，因此不需要额外握手。

```text
请求方                              响应方
建立本地接收记录
       Request(reqId) ────────────→ 建立 Process Listener
       ←──────── Notify(parentId=reqId)
       ←──────── Response(parentId=reqId)
关闭本地接收记录                    移除 Process Listener
```

## 生命周期

AutoSubscribe 只用于 `kind: "event"`。Ability Request 没有过程流，也不会建立该订阅。

最终 Response 到达或发出时，两端会自动移除对应订阅。连接断开、请求失败或 NApp 终止时，相关记录也会随连接状态一起清理。

:::warning
提前退出 `call.stream` 只停止本地迭代，不会解除 AutoSubscribe，也不会中断远端 Event。

需要中断 Event 时，应发送 `abort` Signal。订阅会在最终 Response 时自动关闭。
:::
