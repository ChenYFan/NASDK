# onUnsubscribe

`onUnsubscribe()` 负责根据入站的 [`UnsubscribeMessage`](/transport/nacp/message#unsubscribemessage) 移除事件转发监听。

```ts
NApp.nacp.onUnsubscribe(
  message,
): void
```

| 参数      | 说明                       |
| --------- | -------------------------- |
| `message` | 入站的 UnsubscribeMessage  |

## 行为

### 查找订阅

`onUnsubscribe()` 使用 `message.payload.targetSubId` 查找对应的订阅记录。

显式退订找不到记录时，会报告 `unknown-subscription`，并向退订方发送失败的 Response。

### 移除监听

找到记录后，`onUnsubscribe()` 会从订阅表移除记录，并使用其中的监听 ID 取消当前 NApp EventBus 上的转发监听。

### AutoSubscribe

Event Request 结束时也会复用 `onUnsubscribe()` 清理 [AutoSubscribe](/transport/nacp/auto-subscribe)。这种内部清理不发送 UnsubscribeMessage 或 Unsubscribe Response；记录已经不存在时也不会报告错误。

### 结束时

显式退订完成后，`onUnsubscribe()` 会向退订方发送成功的 Response。

发送方向见 [`unsubscribe()`](../outbound/unsubscribe)，监听的建立见 [`onSubscribe()`](./on-subscribe)。
