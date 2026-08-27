# NACP 1.0.2 Ack 讨论稿

> 本文件位于 `temp/doc`，只记录 NASDK 1.0.2 的讨论结论，不是正式文档或已实现契约。

## 目标

NACP 从 1.0.1 的「尽力而为」变成**可靠传输**：除持久化存储之外，协议层保证消息可达、有序、离线可续发。这是能声称「可靠」的前提。

不采用 MQTT 作为传输层的理由：MQTT 不是为可能传输超大内容设计的，且 NACP 有大量语义需要与上层应用、下层执行层对齐。MQTT 的**论证**值得吸收，**结论集**（QoS 分级、Receive Maximum、Session Expiry）是为它自己的缺失设计的，不照搬。

## 协议回包规则

任何出站消息，第一个期望获得的是 ack，表示「已接收」，这是协议层确认。请求族在此之上还期望 res，表示「已处理」。

| 出站类型 | 第一个期望 | 第二个期望 | 何时算结束 |
|---|---|---|---|
| `request` | ack | res | 收到 res |
| `subscribe` / `unsubscribe` | ack | res | 收到 res |
| `register` / `unregister` | ack | res | 收到 res |
| `response` | ack | — | 收到 ack |
| `signal`（未来） | ack | — | 收到 ack |
| `notify` | — | — | 发出即结束 |
| `ack` | — | — | 发出即结束 |

`notify` 与 `ack` 同构：都不期望回包，区别只是 notify 有自己的 payload。用 MQTT 的话说 notify 是 QoS 0——最终结果由 QoS 1 的 res 负责。

`ack` 不期望回包是必须成立的公理，否则无限递归。

### 过程流的可靠性由应用层决定

notify 定为 QoS 0 意味着 NACP **不保证最终 res 保留了所有 notify 的内容**。res 具体返回什么由应用层自己决定。当前实装中 res 走 `consumeEvent` 的最终结果对象，过程 chunk 走独立的 bus 事件，两者是不同数据。

### 为什么这才是根治

旧设计里 res 同时承担「确认收到」和「报告结果」两个职责，而它们的时间尺度差几个数量级。ack 把两者分开后：

- **ack 超时**是协议层事实——对端版本有问题、真的死了、传输半开、网络质量差。
- **res 超时**是业务层事实——由应用层自己设定，NACP 默认不限制。

## ack 语义

- ack 是完整 NACP 消息，保留标准信封与路由字段。`from`/`to` 与被确认消息反向。
- `id` 自铸新 uuid，被确认消息的 id 放 `meta.parentId`。ack 是回指类，符合 `BaseMeta` 的配对锚约定。
- payload 不存在。不是空对象，而是信封里没有这个 key，因为 CBOR 会把显式 `undefined` 编成真实字段。
- ack 只确认「已接收」，不表达成败。协议层的合法性判断仍由 res 的 `isOk` 表达。

```ts
interface AckMeta extends BaseMeta { parentId: string }
interface AckMessage extends NACPBaseMessage { type: 'ack'; meta: AckMeta }
```

### ack 比传输层更可靠

NACT 的成功只说明字节离开了本端 socket。ack 说明对端 NACP 收到了、信封合法、且认定属于自己。

Gateway 场景下 ack 是端到端的，Gateway 像转发任何消息一样转发它，不代答。否则这个性质失效。

### register 的 ack 是特例

register 是连接后第一条消息，此时 appId 尚未绑定。它的 ack 只能走 `{ peerId }` 直发，与现有 register 拒绝路径同一条通路。

顺带改善诊断：收到 ack 但 res 超时说明对端活着但握手校验失败；连 ack 都没有说明包压根没到。

## 发送方三级流水

```text
OutboundBacklogTable   出站积压
  │  断线态时全部积压在此，不出站
  │  在线时 pop 给下一级
  ▼
AckPendingTable        已出站，等 ack，限时 10s
  │  拿到 ack → pop
  │  10s 未到 → 判定链路异常，主动断连
  ▼
ResponsePendingTable   已确认对方收到，等 res
     不限时
```

`notify` 与 `ack` 过出站积压表，但**绕过 Ack 等待表**——它们不期望 ack，出站即结束。断线期间它们同样被积压，这是条件 FIFO 能优先丢 notify 的前提。

关键推论：**断线态下不存在 ack 等待**，因为消息压根没出站。所以 10s ack 超时只在在线时计，不存在「断线期间计时是否继续」的问题。

### no-route 的两种事实

之前被混成一种，现在分开：

| 情况 | 处理 |
|---|---|
| appId 从未注册 / 拼错 / 从未连过 | 丢弃 + 报错，真的没有路由 |
| appId 曾在线，现处于断线态宽限内 | 入出站积压表，重连续发 |

判别依据是 120s 宽限机制的副产品——宽限本身就要求有「这个 App 断了、计时中」的状态。现在的 `_cleanupPeer` 断线即删 appId，导致两种情况无法区分，需要改成标记断线态。

## 断线与重连

判别只有一个维度：**意外断开，还是已经打过招呼的正常断开。**

| 触发 | 性质 | 处置 |
|---|---|---|
| `nact:peer:disconnect` | 意外 | 标记 appId offline + 120s 计时 |
| ack 10s 超时 | 意外 | 标记 appId offline + 120s 计时 |
| 收到 / 发出 unregister | 正常 | 直接推进到清理 |
| 120s 到期 | — | 执行清理 |

**ack 超时与物理断连处置完全相同**——两者都只是「这个 appId 不可达了」的不同发现途径，都不立即断连接，只标记 appId。ack 超时反而是更早的信号：NACT 心跳最坏需要 2× 间隔（默认 60s）才能确认死亡，ack 10s 就能发现。

断线态下：

- 所有出站消息（含 ack）积压在出站积压表，不出站。
- Ack 等待表中该 App 的条目**集体插队到出站积压表最前面**，重新上线后继续 pop。语义是「不确定对方收到没有，重发一次，靠接收方去重」。
- res waiter 无限等，不因断线失败。

不再有退避重试，也不再有主动重连。断线了就等对方重连。

### 级联

一个 peerId 上可以有多个 appId（经 Gateway 中继的 App 在 register 时同样 `bindAppId`，绑的是 Gateway 那条连接的 peerId）。

- **Gateway offline → 同 peerId 上全部 App 级联 offline。** 否则它们状态是 online 但实际不可达。
- **虚拟 App offline → 不影响 Gateway，也不影响同 peer 上的其它 App。**

### NACT 层清理的判定

清理以 NACP 层为主，NACT 层只在「这条物理连接确实只服务这个 App」时才关，且只在 120s 到期时动。

判定依据必须在**断线瞬间快照**，不能到期时再查——`deleteAppIdbyAppId` 在删 Gateway 的 appId 时会顺手清空 `_gatewayPeerId`，到期时已查不到。

```text
断线瞬间记录：thisPeerId、当时的 gatewayPeerId、当时的 gatewayAppId

120s 到期，用快照判定：
├─ thisPeerId === gatewayPeerId
│  ├─ 且 appId === gatewayAppId  → Gateway 自己：清 NACP 层 + closePeer
│  └─ 否则                        → 虚拟 App：只清 NACP 层，不动 NACT
└─ thisPeerId !== gatewayPeerId   → 直连：清 NACP 层 + closePeer
```

Gateway 是按 **peerId 比对**判定的，不是按 appId 的名字——Gateway 的 appId 可以是任意名字。为此 `PeerAppConnectionTable` 需要在 `_gatewayPeerId` 之外同时记录 `_gatewayAppId`，两者一起写、一起清。

清理做成幂等：虚拟 App 永远只清 NACP 层；若 Gateway 已先被清掉，虚拟 App 到期时再幂等清一次 Gateway 相关内容。同 peerId 上的清理顺序因此不需要显式规定。`closePeer` 本身也幂等（无此 peer 时返回 false，`dropPeer` 返回 false 时不重复 emit）。

### 一对多 bug（既有）

`getAppIdbyPeerId` 与 `deleteAppIdbyPeerId` 都只返回/删除**第一个**匹配的 appId，而 `onPeerDisconnect` 正是用前者。所以 Gateway 断线时只有一个 App 被处理，其余残留在 online 状态但实际不可达。

这是 1.0.1 就存在的问题，级联 offline 依赖它修好，因此本轮一并修：改为返回/处理全部匹配项。

### 为什么不需要在线重传

推论链：

```text
res 不设超时（业务层自己管）
→ 协议层不需要「等太久所以重发」这种判断
→ 连接活着时 NACT 保证有序可达（TCP/Unix/WS 天生），没到就是没到
→ ack 10s 超时 = 链路/对端有问题 = 直接断连
→ 断了之后等重连，重连时续发积压
```

所以在线重传在我们这里不是「不必要」，而是**逻辑上不可能发生**——ack 没来就断了，不会停在「连着但没确认」这个状态。MQTT §4.4 的 `MUST NOT resend at any other time` 在这里是推论而非禁令。

## 四个参数

全部可在 `new NApp()` 配置。

| 参数 | 默认 | 含义 |
|---|---|---|
| ack 超时 | 10s | 超时即判定链路/对端异常，主动断连 |
| 队列字节上限 | 4GB | 每张新表独立计算 |
| 队列条数上限 | 1024 | 每张新表独立计算 |
| App 重连宽限 | 120s | 超过则丢弃该 App 全部积压 |

三张新表各自独立适用 4GB/1024。

## 条件 FIFO

入队时超限，逐出优先级：

```text
1. 新进的是 notify → 直接丢弃新进的这条，不动队列
2. 新进的不是 notify → 从最早开始丢 notify
   → 丢到低于限制则停
   → 丢完所有 notify 仍超限 → 才开始正常 FIFO 丢最早的
```

notify 作为 QoS 0 承担全部牺牲，只有 notify 榨干了才动可靠消息。

单条消息超过字节上限时先逐出所有更旧项，但该条自身保留——队列必须能容纳一条传输层允许的最大消息（NACT `MAX_FRAME_SIZE` = 2GiB），否则恰好对最需要保留的消息禁用了保留。

### 字节口径

只精确统计 Buffer / TypedArray 的 `byteLength`，其余按长度估算。上限因此是近似值。这符合 NACP 为大二进制设计的前提：真正占内存的是字节串。精确做法需要对每条消息额外 CBOR 编码一次，对大 payload 等于编两遍。

## 接收方

`InboundReceivedTable` 保存已处理过的消息 id 与来源 appId，不存 payload。

入站分层，ack 在业务派发之前发出：

```text
1. 信封到达，格式合法，to === self
2. 立刻发 ack                    ← 协议层「已接收」
3. 查 InboundReceivedTable，命中则停   ← 续发不重复处理
4. 派发给 onXxx                  ← 业务层「已处理」
```

第 2 步在第 3 步之前，所以续发的消息会被重新 ack（对端才能释放）但不会被重复处理。

`to !== self` 的转发路径不发 ack——本端不是目的地。

抑制的前提是**确实收到过并且真的处理过**，不能无条件吞掉 `has-no-consumer`。命中去重表才抑制；未命中且无 waiter 仍然报 `has-no-consumer`，保留原有诊断能力。

## 已知缺陷：路径切换乱序

`outbound()` 每次现算路由：显式 peerId → 直连 → Gateway。当两条路径同时有效时可能乱序：

```text
msg1 走 Gateway（2 跳，慢）
      ↓ 期间与目标 App 建立了直连
msg2 走直连（1 跳，快）
→ msg2 先到
```

只有「从 Gateway 升级到直连」这一种切换会产生真乱序。直连断裂退化到 Gateway 时，在途消息已随 socket 丢失，不存在「旧路径的消息后到」。

**刻意不解决**，理由：

- 路由粘性会造成观测困难。
- 序号 + 重排缓冲在协议设计时就没有考虑，引入成本高。
- 时间戳无法解决：`t` 正确记录了发送顺序，但接收侧无法判断「缺口是否存在」。收到 `t=1000` 时不知道 `t=999` 是在路上还是压根不存在，只能选择固定窗口等待（给所有消息加延迟）或直接交付（等于没重排）。序号能表达缺口，时间戳不能。次要问题还有毫秒精度下同毫秒多条无法排序、`Date.now()` 非单调。

NACP 的顺序保证因此表述为：**同一连接内有序**，路径切换窗口内可能乱序。

## MQTT 调研

采纳的：

- **在线不重传的论证**（§4.4 `MUST NOT resend messages at any other time`）。前提是传输层为 ordered/lossless 连接，NACP 与之相同。5.0 相对 3.1.1 收紧了这一条，3.1.1 曾允许计时器重发。
- **QoS 0 用于高频流**。MQTT 靠分级让传感器数据免确认、计费消息四次握手。notify 定为 QoS 0 同源。
- **重传必须保持原序**（§4.6 [MQTT-4.6.0-1]）。对应出站积压表按插入序 pop。
- **有重传就有乱序**。MQTT 非规范注释：断线后订阅方可能收到 `1,2,3,2,3,4`。这是我们「同一连接内有序」表述需要如实承认的部分。

拒绝的：

- **Receive Maximum 流控**。它补的是 MQTT 没有任务层这个缺失。NACEB 已有队列和 `busyKeys` 做资源竞争，在协议层再加配额是重复造轮子，且会与 NACEB 调度打架。
- **Session Expiry Interval**。我们用显式的 120s 重连宽限，不需要它那套会话状态模型。
- **QoS 分级本身**。全类型统一 ack 更简单，notify 免 ack 是按类型固定的，不是按消息选的。
- **DUP 标志**。MQTT 自己也说明去重靠 Packet Identifier 而非 DUP（§3.3.1.1 非规范注释）。我们靠消息 id。

## 表清单

原有 4 张：

| 表 | 作用 |
|---|---|
| `PeerAppConnectionTable` | appId ↔ peerId |
| `ResponsePendingTable` | 等 res，不限时 |
| `SubscribeTable` | 被订阅侧：谁订阅了我的 bus |
| `ListenTable` | 订阅侧：我订阅了谁 |

新增 3 张，各自独立 4GB/1024：

| 表 | 端 | 装什么 | 键 |
|---|---|---|---|
| `OutboundBacklogTable` | 发送方 | 待出站（含断线积压、插队回来的未确认） | 消息 id |
| `AckPendingTable` | 发送方 | 已出站、等 ack，10s | 消息 id |
| `InboundReceivedTable` | 接收方 | 已处理过的消息 id | 消息 id |

## 已写代码的状态

| 已写 | 状态 |
|---|---|
| `NACPType` 加 `'ack'`、`AckMeta`、`AckMessage`、`buildMessage` | 可用 |
| 基类 `payload?: any`，删除 `WidenPayload` / `NACPWireMessage` | 可用，独立清理 |
| `measureBytes` | 可用 |
| `ackWarning` / `ackError` / `AckWarningPayload` | 需调整——不再有 `retry-exhausted` |
| `AckPendingTable` | 需改——去掉退避与 per-record 定时器，改 10s 统一超时 |
| `ReceivedResponseTable` | 改名 `InboundReceivedTable`，泛化到所有类型，加容量上限 |
| `PendingEntry.graceable` | 需改——断线态下 waiter 一律无限等，不需要这个字段 |
| — | 新建 `OutboundBacklogTable` |

## 实施计划

按依赖顺序，每步可独立 typecheck。

### 阶段一：表层（无行为变更）

1. **`OutboundBacklogTable`** 新建。Map 保插入序；`unshift` 语义支持 AckPending 集体插队到最前；条件 FIFO（notify 优先牺牲）；4GB/1024 上限；按 appId 分组的 pop 与丢弃。
2. **`AckPendingTable`** 改造。去掉 `retryCount` / `nextRetryAt` / per-record 退避定时器，改为单一 10s 超时；加 4GB/1024 上限；`drainByAppId` 返回条目供插队。
3. **`InboundReceivedTable`**（原 `ReceivedResponseTable`）改名、泛化到所有类型、加 4GB/1024 上限。notify 与 ack 不建记录。
4. **`PendingEntry`** 去掉 `graceable`——断线态下 waiter 一律无限等，不再需要判别。

### 阶段二：离线态

5. **`PeerAppConnectionTable` 扩展**。记录从 `appId → peerId` 变为带状态的记录：`online` / `offline`，offline 时携带断线瞬间的快照（thisPeerId、gatewayPeerId、gatewayAppId）与 120s 计时。增加 `_gatewayAppId`。
6. **一对多 bug 修复**。`getAppIdbyPeerId` / `deleteAppIdbyPeerId` 改为处理全部匹配项，级联 offline 依赖它。
7. **`_cleanupPeer` 拆分**。按方案 B 分三个时机：意外断开只标记 + 计时；120s 到期执行清理（含 NACT 层判定）；unregister 立即清理。

这不是状态机——只有两个状态、四条由外部事件直接驱动的转移，没有 tick、没有 Hook、没有 Veto、没有「等条件成立」的状态。实现上是记录上的一个字段，不是 FSM 类。

### 阶段三：出站路径

7. **`outbound()` 前置积压**。在线直接 pop（入队即出队），断线态积压。返回值语义改为「已接受」。
8. **各出站方法首发入队**，加 `retransmit` 开关跳过一次性副作用（AutoSub 收尾、重复入队）。
9. **Promise 结束条件**。请求族等到「res 到达 + 自己的 ack 出站」；`response` 等对方 ack；`notify` / `ack` 等真正出站。

### 阶段四：入站路径

10. **`inbound` 三层**。发 ack → 查 `InboundReceivedTable` → 派发。`to !== self` 的转发路径不发 ack。
11. **`onAck`**。结算 AckPending；未命中只 emit `ackError`。
12. **ack 超时断连**。走与心跳失败同一条清理路径。

### 阶段五：重连与收尾

13. **重连恢复**。挂 `bound`，AckPending 条目插队到积压表最前，按插入序 pop。
14. **`unregister` 顺序严格化**。收 res → 发 ack → 清理。
15. **`NAppOpts`** 加四个参数。
16. **`terminate()`** 清理三张新表与所有计时器。

### 阶段六：验证

17. 测试。
18. `npm run typecheck` + `npm test` 全量通过。

## 公共 API 的 Promise 结束条件

出站族全部是 `async`。结束条件按回包规则表推导，不额外暴露中间里程碑。

| 方法 | Promise 结束于 |
|---|---|
| `request` | 收到 res **且**自己为该 res 回的 ack 已真正出站 |
| `subscribe` / `unsubscribe` | 同上 |
| `register` / `unregister` | 同上 |
| `response` | 自己发出的 res 收到对方 ack |
| `notify` | 已真正出站（不等 ack） |
| `ack` | 已真正出站 |

「已真正出站」= 已交给 NACT，不是「已入积压表」。因此断线态下所有出站族都卡住，直到重连 pop 或宽限到期。这比返回 `false` 诚实——断线宽限内消息确实会送达，返回 false 会误导。

`request` 一次往返的闭合点是「我们的 ack 出站」而不是「res 到达」，这样双方都确认了对方收到。

### unregister 与 register 的处理

两者都是 NACP 内部协议族的边缘情况，重要性相当于 QoS 1~2，**都要发 ack**，不做豁免。

`unregister` 的清理顺序严格化为：

```text
收到 res → 发出 ack → 才执行清理与丢弃积压
```

既然发了 unregister 就当回事；要立即断连就直接断连，不走 unregister。

`register` 的 ack 走 `{ peerId }` 直发，不过积压表——此时 appId 尚未绑定。这是特例而非冲突，与 register 的 res 走同一条通路。

## 尚未确定

- 三张表各自 4GB/1024 意味着单个 NApp 最坏情况下持有 8GB+（积压 + 等待，去重表只存 id 不计）。是否需要一个跨表的全局上限。

## 待跟进

- **断线洪流。** 重连瞬间积压表整体 pop，最坏 4GB 一次性涌出。已知不好解决，需要单独开 issue。
- **时间轮。** 当前不需要——废除退避后没有 per-record 定时器，只有每个 peer 一个 10s ack 超时计时。若将来 notify 也需要确认才会重新成为问题。
