# 出站

NACP 出站族函数负责构造 NACPMessage 并提交发送。

## NACP 出站具体方法

:::tip
尽管可以直接使用`NApp.nacp.xxx`直接访问nacp并发送消息，但是通常来讲不建议这么做，会丢失NApp Stream等封装。
:::

| 方法          | 返回                               | 返回时机           | 通常由谁调用                        |
| ------------- | ---------------------------------- | ------------------ | ----------------------------------- |
| `register`    | `Promise<boolean>`                 | `ACK` + <br> `RES` | `NApp.connect()`                    |
| `unregister`  | `Promise<ResponseMessage>`         | `ACK` + <br> `RES` | `NApp.disconnect()` / `terminate()` |
| `request`     | `Promise<ResponseMessage>`         | `ACK` + <br> `RES` | `NApp.request()`                    |
| `response`    | `Promise<boolean>`                 | `ACK`              | Processor 回调 / `NApp.response()`  |
| `subscribe`   | `Promise<ResponseMessage> \| void` | `ACK` + <br> `RES` | `NApp.subscribe()` / NACP 内部      |
| `unsubscribe` | `Promise<ResponseMessage> \| void` | `ACK` + <br> `RES` | `NApp.unsubscribe()` / NACP 内部    |
| `notify`      | `Promise<boolean>`                 | -                  | 订阅转发 / `NApp.notify()`          |
| `signal`      | `Promise<boolean>`                 | `ACK`              | `NApp.signal()`                     |
| `ack`         | `Promise<boolean>`                 | -                  | NACP 入站流程                       |

:::warning

目标暂时离线时，可靠消息可以进入积压表等待重连。消息进入积压表不代表上述 Promise 已经完成。

具体的离线、补发和超时行为见[生命周期](/transport/nacp/lifecycle)。

`request` 等待业务的最终 Response，因此没有处理时限。

`register`、`unregister`、`subscribe` 和 `unsubscribe` 等待协议操作的 Response，超时为 10 秒。

:::

## NACP 出站

```ts
NApp.nacp.outbound(
  NACPMessage,
  opt?,
): boolean
```

`outbound()` 是所有 NACP 消息共用的底层提交入口，所有的具体方法都是通过这一入口完成提交。

它接收一条已经构造完成的 [`NACPMessage`](/transport/nacp/message)，根据 `message.to` 选择路由，并将消息放入积压表或提交给 NACT。

| 参数             | 说明                                               |
| ---------------- | -------------------------------------------------- |
| `message`        | NACPMessage完整对象                                |
| `opt.peerId`     | 绕过 App 路由，直接向指定 NACT Peer 发送           |
| `opt.forwarded`  | 标记为 Gateway 转发消息，不进入本地积压与 ACK 跟踪 |
| `opt.retransmit` | 标记为积压消息重发，避免重复加入积压表             |

返回 `true` 只表示消息已被 NACP 接纳，目标离线、消息仍停留在积压表时也会返回 `true`。

返回 `false` 表示消息因发给自己、没有路由、发送失败或容量限制而未被接纳。

:::danger
**一般情况下不应直接调用** `NApp.nacp.outbound()`。

它只负责提交一条已经构造好的消息，不会执行各具体出站方法的配套副作用，包括：

- 不会为 Request、Subscribe 等消息建立 Response 等待记录；
- 不会为可靠消息建立可供调用方等待的 ACK Promise；
- 不会建立或清理 Subscribe / AutoSubscribe 的本地记录；
- 不会执行 Register 的 App-Peer 绑定、身份校验和 Gateway 结算；
- 不会执行 Unsubscribe、Response 等方法附带的本地清理；
- 不会替调用方构造、补全或校验 NACPMessage。

直接用`outbound`发送消息，线上确实可能会出现对应数据，但本地状态与回包无法正确关联。

除 NACP 内部路由、重发和 Gateway 转发外，应使用对应的NACP具体出站方法。
:::

## 路由

NACP 根据消息信封中的 `to` 选择路由。

```text
目标是自己
  → 拒绝发送

目标未知，但本 App 已连接 Gateway
  → 交给 Gateway 转发

目标未知，且本 App 未连接 Gateway
  → 拒绝发送

目标已知且在线
  → 通过目标对应的 Peer 发送

目标已知但离线
  → 进入 backlog，等待目标重连
```

Gateway 只负责转发，不会修改消息的 `from` 和 `to`。

Gateway 的使用方式见 [NApp Gateway](/napp/advanced/gateway)。

接收方如何处理这些消息见[入站族函数](/transport/nacp/inbound)，出站错误与观测事件见[可观测](/transport/nacp/observability)。

各消息的字段与协议语义见对应子页面。
