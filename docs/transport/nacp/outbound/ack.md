# ack

向目标节点发送一条知晓消息，确认之前的消息已被接收。

:::danger
这个方法完全不需要手动调用，NACP会自己处理ack回复的目标。

此外ack只能代表原先的消息已经被接收，不能代表原先的消息被处理！
:::

```ts
NApp.nacp.ack(to, {
  parentId,
}): Promise<boolean>
```

| 参数       | 说明                       |
| ---------- | -------------------------- |
| `to`       | 被确认消息的发送方 NApp ID |
| `parentId` | 被确认消息的 ID            |

该方法生成 [`AckMessage`](/transport/nacp/message#ackmessage) 并出站。

`parentId` 是被确认消息的 `id`。ACK 没有 `payload`，也不会再期待 ACK 或 Response。

## 返回值

```mermaid
sequenceDiagram
    participant A as App A
    participant B as App B

    A-->>B: ACK
```

`ack()` 在本端 Provider 成功接纳该 ACK 包的全部 NACT 帧后 resolve `true`，不等待对端确认。接纳失败或消息被放弃时 resolve `false`；断连宽限期间可继续等待重连。

ACK 的接收与结算见 [onAck](/transport/nacp/inbound/on-ack)。
