# onUnregister

`onUnregister()` 负责响应入站的 [`UnregisterMessage`](/transport/nacp/message#unregistermessage)，并清理发送方的协议状态。

```ts
NApp.nacp.onUnregister(
  message,
): void
```

| 参数      | 说明                      |
| --------- | ------------------------- |
| `message` | 入站的 UnregisterMessage  |

## 行为

### 返回 Response

`onUnregister()` 会先发送成功的 Response。此时不能先清理发送方，因为 Response 仍需要现有的 App 路由才能发出。

### 清理协议状态

Response 提交后，NACP 会立即遗忘 `message.from`：

- 移除 App ID 与 Peer 的绑定。
- 结束与该 App 有关的 Response 等待方。
- 移除双方持有的订阅记录和 EventBus 监听。
- 放弃该 App 的积压消息并结算对应等待方。

### 结束时

Unregister 表示对端主动离开，因此清理不会进入离线宽限期。物理连接意外断开时才会保留状态并等待重连。

发送方向见 [`unregister()`](../outbound/unregister)，断连与宽限行为见[生命周期](/transport/nacp/lifecycle)。
