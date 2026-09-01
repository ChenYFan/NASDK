# 入站与出站

NACT 负责在与 NACP 和实际物理传输中完成 NACPMessage 与 字节流内容的转换。

## 出站

```ts
nact.sendToPeer(peerId: NACTPeerId, msg: NACPMessage): boolean
```

在执行本函数时，会先进行CBOR编码、NACT Framing分帧和补头，最后选择指定的底层方式完成传输。

:::warning
`sendToPeer`返回true只能代表进入了物理发送队列，不能代表发送成功。
:::

## 入站

入站的流程和出站相反，指定的监听器接收到消息后需要先解析NACT Frame，重组完整消息包后再完成解码和`nacp.inbound`入站。

TCP 与 Unix Socket 是裸字节流，由 Framer 识别帧边界。WebSocket 自带消息边界，但仍使用相同的 NACT Frame 和重组格式。

Framing 或 CBOR 解码失败时，NACT 发布 `nact:peer:error` 并断开对应 Peer。

事件及原因见[可观测](/transport/nact/observability)。

## CBOR

NACT 默认使用 `cbor-x` 编解码：

```ts
interface Codec {
  encode(msg: NACPMessage): Uint8Array
  decode(data: Uint8Array): NACPMessage
}
```

CBOR 可以直接编码 Buffer、Uint8Array 等二进制载荷，不需要转换为 Base64。

:::tip
**NASDKv1.0.3** `compression` 是预留配置，当前不会改变编码行为。
:::

## 拷贝与顺序

接收端按 `totalSize` 预分配重组缓冲区，每个 Frame Body 直接写入对应 `offset`。

WebSocket 在发送前需要将 Header 与 Body 合并为一个 Frame。

:::warning
同一 Peer 上的传输顺序由 WebSocket、TCP 或 Unix Socket 保证，NACT 不额外增加消息序号。
:::

---

分片过程见 [NACT Framing](/transport/nact/framing)，Peer 的建立与移除见[生命周期](/transport/nact/lifecycle)。
