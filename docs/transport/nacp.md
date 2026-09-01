# NACP

NACP 全称 Nyirusu Application Control **Protocol**。

NACP 是 NApp 通讯协议层，负责规范 NACPMessage 的 RPC-style 格式。

## NACP Message Type

| type          | 含义                                     | ACK | 期待回包                         |
| ------------- | ---------------------------------------- | --- | -------------------------------- |
| `register`    | 注册，链接时发送的第一条消息             | √   | `1 response`                     |
| `unregister`  | 取消注册                                 | √   | `1 response`                     |
| `request`     | 请求，发送一次事件或能力调用             | √   | `1 response` + <br/>`0~N notify` |
| `response`    | 响应，表示一个消息的最终结果             | √   | -                                |
| `subscribe`   | 订阅，远程订阅一个NApp的消息总线         | √   | `1 response`                     |
| `unsubscribe` | 取消订阅                                 | √   | `1 response`                     |
| `notify`      | 通知，发送订阅的中途消息                 | ×   | -                                |
| `signal`      | 信号，对一个正在进行中的事件发送中途补充 | √   | -                                |
| `ack`         | 知晓，表示对方已成功接收并准备处理消息   | -   | -                                |

:::tip
其中，`register`和`unregister`一般不需要NApp外部手动发送。

还需要注意的是，对于`notify`，接收方是不会发送`ack`消息确认的。
:::

## 更多

- 出站族函数与各消息类型详解：[出站族函数](/transport/nacp/outbound)
- 入站处理流程：[入站族函数](/transport/nacp/inbound)
- 上下线、宽限窗口与消息补发：[生命周期](/transport/nacp/lifecycle)
- 可观测：[可观测](/transport/nacp/observability)
- Gateway 的使用方式：[NApp Gateway](/napp/advanced/gateway)

:::warning

1. NACP被设计为可靠传输，具有一定消息队列性质，但以下缺陷是已知的、并且未来大概率不会去修正的：

- 断线重连、路由变动后一部分包发送可能会乱序，没有seq机制
- 没有进程意外退出后持久化保存队列
- `notify` 被设计为`MQTT Qos 0 Like`，即只发送、不确认对方是否收到。

2. NACP乃至NASDK **都没有鉴权层**、没有用户身份概念，默认连接的都是可信 App。
3. NACP的路由选择只看NACP消息中的`to`字段，Gateway也不会去转换和修改。

:::
