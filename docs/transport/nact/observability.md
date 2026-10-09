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
| `nact:peer:error`      | 连接失败           | `{ peerId, reason }` |

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

Peer 与 App 的后续生命周期见 [NACT 生命周期](/transport/nact/lifecycle)和 [NACP 生命周期](/transport/nacp/lifecycle)。

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
| `version-mismatch`       | NACT 帧版本不受支持                      | 全部              |
| `bad-magic`              | 帧 magic 与对应版本不匹配                | 全部              |
| `frame-too-large`        | 帧超过 2 GiB                             | 全部              |
| `frame-too-small`        | 帧小于 32 Bytes 帧头                     | 全部              |
| `frame-size-mismatch`    | 帧头中的长度与交付的帧长度不同           | 全部              |
| `non-binary-frame`       | WebSocket 收到非二进制 Message           | WebSocket         |
| `frame-out-of-bounds`    | 帧 Body 超出所属 NACP 包的范围           | 全部              |
| `overlapping-frame`      | 帧 Body 与已收到的部分重叠               | 全部              |
| `reassembly-timeout`     | 同一 NACP 包在 30 秒内没有重组完成       | 全部              |
| `decode-failed`          | CBOR 解码失败                            | 全部              |
| `transport-error`        | 失败原因既不是字符串也不带字符串 `code`  | 全部              |

Provider 报出的失败原因如果本身是字符串，或带有字符串 `code`，都会原样作为 reason，比如系统网络错误 `ECONNRESET`。官方 Provider 还会报告：

| reason                    | 含义                                  | 传输            |
| ------------------------- | ------------------------------------- | --------------- |
| `receive-buffer-overflow` | 接收缓冲超过 `maxBufferedBytes`       | Streamable HTTP |
| `send-buffer-overflow`    | 发送缓冲超过上限                      | Streamable HTTP |
| `body-too-large`          | 上行 POST 超过 `maxBodyBytes`         | Streamable HTTP |
| `upload-aborted`          | 上行 POST 中途被中断                  | Streamable HTTP |
| `invalid-http-preface`    | 下行 Stream 的开头不是 NACT 前导字节  | Streamable HTTP |
| `http-post-<状态码>`      | 上行 POST 返回非 2xx                  | Streamable HTTP |

帧格式与校验规则见 [NACT Framing](/transport/nact/framing)，入站解码流程见[入站与出站](/transport/nact/inbound-outbound)。

## 抛出的错误

NACT 对外抛出的错误都是 `NACTError`（`layer` 为 `NACT`），带有 `phase` 和 `code`：

| 调用                                              | `code`                                                                                                   | `phase`    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| `nact.use()`                                      | `provider-already-registered`                                                                            | `internal` |
| `listen()` / `dial()`，以及 `start()` / `connect()` | `provider-not-found`                                                                                     | `internal` |
| `listen()` / `dial()`                             | Provider 错误的 `code`，比如 `EADDRINUSE`、`ECONNREFUSED`、`connect-timeout`；没有时为 `listen-failed` / `dial-failed` | `internal` |
| 发送消息                                          | `encode-failed`                                                                                          | `outbound` |
| `sendToPeer()` / `Peer.send()`                    | 接纳失败原因的 `code`，没有时为 `transport-error`；接纳前关闭为 `transport-closed`                          | `outbound` |

Provider 的原始错误保存在 `cause` 中。编码失败只影响这一条消息，连接不会断开。

`sendToPeer()` / `Peer.send()` 通过 Promise reject 报告接纳失败。接纳成功后的传输失败通过 `nact:peer:error` 报告。
