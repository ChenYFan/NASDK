# onSignal

`onSignal()` 负责将入站的 [`SignalMessage`](/transport/nacp/message#signalmessage) 移交给 Event Processor。

```ts
NApp.nacp.onSignal(
  message,
): Promise<void>
```

| 参数      | 说明                 |
| --------- | -------------------- |
| `message` | 入站的 SignalMessage |

## 行为

### 广播 Signal

`onSignal()` 使用 `message.meta.parentId` 关联目标 Event Request，并在当前 NApp 内广播完整的 SignalMessage。

### 移交 Processor

`onSignal()` 将 Signal 移交给 Event Processor：

- `normal` 携带 `signalId`、`reqId`、`kind` 和 `payload`。
- `pause`、`resume`、`abort` 携带 `signalId`、`reqId` 和 `kind`。

Processor 的具体行为见 [Event Processor](/workflow/processor/event-processor)。

### 失败时

没有 Event Processor 时会报告 `no-event-processor`；Processor 拒绝 Signal 或抛出异常时会报告 `processor-rejected`。

发送方向见 [`signal()`](../outbound/signal)。
