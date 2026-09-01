# NACT

NACT 全称 Nyirusu Application Control **Transparent**。

NACT 是 NASDK 的传输承载层，也可理解为 NACTransport（传输）。

NACT 负责在 [NACP](/transport/nacp) 与物理连接之间传递消息，并抹平 WebSocket、TCP 和 Unix Socket 的差异。

NACT 对上只暴露统一的 `Peer`：

```ts
interface Peer {
  id: NACTPeerId
  send(msg: NACPMessage): void
  close(): void
  terminate?(): void
}
```

## 更多

- 分片与重组：[NACT Framing](/transport/nact/framing)
- 三种承载与配置：[底层传输](/transport/nact/transport)
- 收发与编解码：[入站与出站](/transport/nact/inbound-outbound)
- 连接生命周期：[生命周期](/transport/nact/lifecycle)
- 观测事件清单：[可观测](/transport/nact/observability)
