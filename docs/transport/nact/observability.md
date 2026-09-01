# NACT 可观测

NACT 同样不持有独立 [EventBus](/napp/eventbus)，所有观测事件都发布到所属 NApp 的 `app.bus`。

```js
const listenerId = app.bus.listen("nact:peer:*", (payload, hitKey) => {
  console.log(hitKey, payload)
})

app.bus.off(listenerId)
```

NACT 只有一组 Peer 事件：

| 事件名                 | 触发时机           | payload              |
| ---------------------- | ------------------ | -------------------- |
| `nact:peer:connect`    | 物理连接建立       | `{ peerId }`         |
| `nact:peer:disconnect` | Peer 移出连接表    | `{ peerId }`         |
| `nact:peer:error`      | Framing 或解码失败 | `{ peerId, reason }` |

## 连接事件

### connect

```js
nact:peer:connect
```

Peer 创建并写入 `peerTable` 后触发。此时只代表物理连接建立，NACP Register 尚未完成，对端 App ID 可能仍然未知。

### disconnect

```js
nact:peer:disconnect
```

Peer 成功移出 `peerTable` 后触发，同一 Peer 只会触发一次。

NACP 收到该事件后，将对应 App 转为 `offline`。

eer 与 App 的后续生命周期见 [NACT 生命周期](/transport/nact/lifecycle)和 [NACP 生命周期](/transport/nacp/lifecycle)。

:::tip
`nact.terminate()` 会先清空 `peerTable`，因此整层终止时不会为每个 Peer 分别触发 `nact:peer:disconnect`。
:::

## 错误事件

```text
nact:peer:error
```

```ts
interface PeerErrorPayload {
  peerId: NACTPeerId
  reason: PeerErrorReason
}
```

错误事件先报告原因，随后 NACT 关闭对应 Peer，直到 Peer 离开连接表时再触发 `nact:peer:disconnect`。

| reason                   | 含义                                     | 传输              |
| ------------------------ | ---------------------------------------- | ----------------- |
| `version-mismatch`       | NACT Frame 版本不受支持                  | 全部              |
| `bad-magic`              | Frame magic 与对应版本不匹配             | 全部              |
| `frame-too-large`        | Frame 或完整消息超过 2 GiB               | 全部              |
| `frame-too-small`        | Frame 小于 32 Bytes Header               | 全部              |
| `frame-size-mismatch`    | Header 长度与 WebSocket Message 长度不同 | WebSocket         |
| `non-binary-frame`       | WebSocket 收到非二进制 Message           | WebSocket         |
| `fragment-out-of-bounds` | Frame Body 超出完整消息范围              | 全部              |
| `overlapping-fragment`   | Frame Body 与已接收区间重叠              | 全部              |
| `reassembly-timeout`     | 同一消息在 30 秒内没有重组完成           | 全部              |
| `decode-failed`          | CBOR 解码失败                            | 全部              |
| `framer-error`           | 裸字节流 Framer 的无法解析               | TCP / Unix Socket |

Frame 格式与校验规则见 [NACT Framing](/transport/nact/framing)，入站解码流程见[入站与出站](/transport/nact/inbound-outbound)。
