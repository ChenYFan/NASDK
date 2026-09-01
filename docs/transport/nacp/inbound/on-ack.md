# onAck

`onAck()` 负责使用入站的 [`AckMessage`](/transport/nacp/message#ackmessage) 结算对应的可靠消息。

```ts
NApp.nacp.onAck(
  message,
): void
```

| 参数      | 说明              |
| --------- | ----------------- |
| `message` | 入站的 AckMessage |

## 行为

### 查找消息

`message.meta.parentId` 指向被确认消息的 `id`。`onAck()` 使用该 ID 从 ACK 等待表中取出对应消息。

找不到记录时，会报告 `has-no-consumer` 并结束处理。常见原因是重复 ACK，或对应消息已经被放弃。

### 结算等待方

找到记录后，`onAck()` 会以 `true` 结算该消息的 ACK Promise，并从等待表移除记录。

AckMessage 自身不回复 ACK，也不进入去重表。

发送方向见 [`ack()`](../outbound/ack)，可靠消息的队列行为见[生命周期](/transport/nacp/lifecycle)。
