# onNotify

`onNotify()` 负责将入站的 [`NotifyMessage`](/transport/nacp/message#notifymessage) 移交给对应的本地订阅监听器。

```ts
NApp.nacp.onNotify(
  message,
): void
```

| 参数      | 说明                  |
| --------- | --------------------- |
| `message` | 入站的 NotifyMessage  |

## 行为

### 查找监听器

`message.meta.parentId` 是显式订阅的 `subId`，或 Event Request 的 `reqId`。`onNotify()` 使用该 ID 查找本地监听记录。

找不到记录时，会报告 `has-no-consumer`，不会向发送方回包。

### 移交监听器

找到记录后，`onNotify()` 会把 `message.payload` 和完整的 NotifyMessage 移交给记录中的 `targetListener`。

Notify 是过程推送，不结算 Response 等待方，也不结束订阅。

### 结束时

Notify 不需要 ACK 或 Response。对应监听会继续接收后续 Notify，直到显式退订、Event Request 结束或连接状态被彻底清理。

发送方向见 [`notify()`](../outbound/notify)，监听的建立见 [`onSubscribe()`](./on-subscribe)。
