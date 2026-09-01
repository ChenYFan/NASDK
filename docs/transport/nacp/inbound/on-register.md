# onRegister

`onRegister()` 负责校验入站的 [`RegisterMessage`](/transport/nacp/message#registermessage)，并建立 App ID 与 NACT Peer 的绑定。

```ts
NApp.nacp.onRegister(
  message,
  peer,
): void
```

| 参数      | 说明                         |
| --------- | ---------------------------- |
| `message` | 入站的 RegisterMessage       |
| `peer`    | 承载 Register 的 NACT Peer   |

## 行为

### 握手检查

`onRegister()` 会拒绝以下情况：

| 原因               | 含义                              |
| ------------------ | --------------------------------- |
| `dual-gateway`     | 通信双方都声明为 Gateway          |
| `version-mismatch` | NACP 主版本不兼容                  |
| `appId-in-use`     | 相同 App ID 已在线                |
| `multi-gateway`    | Gateway 槽位已被其他连接占用       |

离线宽限期内重新注册的相同 App ID 不属于 `appId-in-use`，会按重连处理。

### 建立绑定

检查通过后，`onRegister()` 会绑定 `message.from` 与入站 Peer，并根据 `message.payload.isGateway` 结算 Gateway 槽位。

Register 在绑定前无法按 App ID 回复 ACK，因此会在绑定完成后补发。

### 返回声明

绑定完成后，`onRegister()` 会发送成功的 Response，并在 payload 中返回当前 NApp 的 `isGateway` 与 `decl`。

### 重连时

如果该 App 此前处于离线宽限期，握手完成后会取消宽限计时，并按原顺序补发积压消息。

发送方向见 [`register()`](../outbound/register)，连接状态见[生命周期](/transport/nacp/lifecycle)。
