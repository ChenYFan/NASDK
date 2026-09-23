# NACT

NACT 全称 Nyirusu Application Control **Transparent**。

NACT 是 NASDK 的传输承载层，也可理解为 NACTransport（传输）。

NACT 负责在 [NACP](/transport/nacp) 与网络连接之间传递消息。应用可以选择 WebSocket、TCP、Unix Socket 或 Streamable HTTP；安装对应传输包后，即可通过相同的 `start()`、`connect()` 和 Peer 接口使用。

不同传输只影响如何监听和连接。连接建立后，Server 和 Client 都可以通过 NACP 双向发送消息，不再区分数据方向。

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

- 收发与编解码：[入站与出站](/transport/nact/inbound-outbound)
- 分片与重组：[NACT Framing](/transport/nact/framing)
- 安装、监听与连接：[底层传输](/transport/nact/transport)
- 各运行时安装哪个包：[运行时接入](/transport/nact/runtime-build)
- 连接生命周期：[生命周期](/transport/nact/lifecycle)
- 观测事件清单：[可观测](/transport/nact/observability)
- 扩展自定义传输：[自定义传输Provider](/transport/nact/provider)
