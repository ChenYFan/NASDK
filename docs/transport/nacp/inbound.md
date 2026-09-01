# 入站

NACP 入站族函数负责接收 NACT 交付的 [`NACPMessage`](/transport/nacp/message)，完成路由判断、ACK、去重和具体消息处理。

## NACP 入站

```ts
NApp.nacp.inbound(
  message,
  peer,
): void
```

| 参数      | 说明                        |
| --------- | --------------------------- |
| `message` | NACT 解码得到的 NACPMessage |
| `peer`    | 承载这条消息的 NACT Peer    |

:::tip
`inbound()` 是 NACP 的统一入站入口，一般由下游NACT调用。
:::

:::warning
`inbound()` 接收的是已经完成 NACT 解码的消息，不负责 CBOR 解码，也不替构造或校正 NACPMessage。

直接调用本接口将伪造一次消息入站，但一般情况下不建议这么做。
:::

## NACP入站具体方法

| 方法                                          | 作用                                | 回复 ACK | 进入去重表 |
| --------------------------------------------- | ----------------------------------- | -------- | ---------- |
| [`onRequest()`](./inbound/on-request)         | 建立 AutoSubscribe 并交给 Processor | √        | √          |
| [`onResponse()`](./inbound/on-response)       | 结算 Response 等待方                | √        | √          |
| [`onSubscribe()`](./inbound/on-subscribe)     | 建立 EventBus 转发监听              | √        | √          |
| [`onUnsubscribe()`](./inbound/on-unsubscribe) | 移除 EventBus 转发监听              | √        | √          |
| [`onRegister()`](./inbound/on-register)       | 校验握手、绑定 App ID、交换声明     | √（补）  | √          |
| [`onUnregister()`](./inbound/on-unregister)   | 回复 Response 并清理对端协议状态    | √        | √          |
| [`onSignal()`](./inbound/on-signal)           | 将 Signal 交给 Event Processor      | √        | √          |
| [`onNotify()`](./inbound/on-notify)           | 将 Notify 交给本地订阅监听器        | ×        | ×          |
| [`onAck()`](./inbound/on-ack)                 | 结算 ACK 等待方                     | ×        | ×          |

:::warning
这些方法是 `inbound()` 的内部消息处理分支，不是供业务代码直接调用的公开接口。
:::

## 处理流程

```text
NACT 收到并解码消息
  → emit nacp:inbound:{type}
  → 检查 message.to
      → 不是自己：Gateway 转发或丢弃
      → 是自己：继续处理
  → AckMessage：直接结算等待中的可靠消息
  → 其他可靠消息：先回复 ACK
  → 检查重复消息
  → 按 message.type 分发到 onXxx
```

:::tip
重复到达的可靠消息会再次收到 ACK，但在去重记录有效期间不会再次进入具体 `onXxx` 处理。

RegisterMessage 握手通过前还没有 App ID 与 Peer 的绑定，`onRegister()` 会暂时跳过回复ACK，在绑定完成后补发 ACK。
:::

## Gateway 转发

当 `message.to` 不是当前 NApp 时：

```text
RegisterMessage
  → 丢弃，不允许转发

当前 NApp 是 Gateway，且能够路由到 message.to
  → 保持 from / to 不变，原样转发

其他情况
  → 丢弃并报告 nacp:internal:gateway:error
```

Gateway 转发不会在当前 NApp 执行 ACK、去重或 `onXxx`。可靠消息仍由原发送方和最终接收方维护。

发送方向见[出站](/transport/nacp/outbound)，入站错误与观测事件见[可观测](/transport/nacp/observability)。
