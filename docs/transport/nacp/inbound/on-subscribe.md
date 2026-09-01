# onSubscribe

`onSubscribe()` 负责根据入站的 [`SubscribeMessage`](/transport/nacp/message#subscribemessage) 建立事件转发监听。

```ts
NApp.nacp.onSubscribe(
  message,
): void
```

| 参数      | 说明                     |
| --------- | ------------------------ |
| `message` | 入站的 SubscribeMessage  |

## 行为

### 订阅名检查

`message.payload.targetSubName` 必须是非空字符串。检查失败时会报告 `bad-target-sub-name`，并向订阅方发送失败的 Response。

### 构建转发监听

`onSubscribe()` 在当前 NApp 的 EventBus 上监听 `targetSubName`，并将每次命中的事件转换为 [`NotifyMessage`](/transport/nacp/message#notifymessage) 发给订阅方。

随后以 SubscribeMessage 的 `id` 作为 `subId`，保存订阅方、监听 ID 和订阅名。后续 Unsubscribe 使用该 `subId` 移除监听。

### AutoSubscribe

Event Request 构建 [AutoSubscribe](/transport/nacp/auto-subscribe) 时也会复用 `onSubscribe()`，但不会产生独立的 SubscribeMessage 或 Subscribe Response。

### 结束时

显式订阅建立成功后，`onSubscribe()` 会发送成功的 Response，并在 `payload.targetSubId` 中返回 `subId`。

发送方向见 [`subscribe()`](../outbound/subscribe)，移除监听见 [`onUnsubscribe()`](./on-unsubscribe)。
