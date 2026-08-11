<!--AGENT_ATTENTION--
本文档内有一部分内容为了减少人类阅读负担，是仅AI可见的。
如果你是Agent，请非常严格地遵循注释为--AGENT_ATTENTION--的部分！
-->

# NACT

NACT 全称 Nyirusu Application Control **Transparent**，是NASDK中的传输承载层。也可理解为 NACTransport （传输）。

NACT的存在意义就是抹平 ws、tcp、unix 三种传输协议的差异，把它们变成一套统一的 JS 出入站接口，统一一套API给协议层(NACP)使用。

NACT 与 [NACP](./nacp.md)、[NApp](./napp.md) 三者平行，同属 NASDK 直属成员。




## 用词规范

| 词 | 指什么 |
|---|---|
| 承载 carrier | 物理线缆类型 `ws` / `tcp` / `unix`，三者全是一等承载 |
| Peer | NACT 对上暴露的统一物理连接抽象，收发的是对象，不是字节 |
| peerId | 物理连接标识，建连时铸刻的 uuid。NACP 用它寻址但不理解物理含义 |
| framer | 分帧器，把 tcp/unix 裸字节流抹成消息流。帧长写在 32B 头内的 `thisFrameSize` |
| 分片 chunking | 把一条大消息切成多个不超过阈值的片，接收方重组，为穿透中间层而非省内存 | 


## 核心能力

**唯一职责**：把 ws / tcp / unix 的收发、连接生命周期、出入站编解码，统一成 Peer 抽象。


NACT不会解读具体含义，整条消息在 NACT 看来就是一个大对象，它按 CBOR 把对象编码成字节发出去、把字节解码回对象交上去，全程不知道任何字段是什么意思。能遍历打包不等于解读语义。
NACT不会做任何鉴权。Peer 接口只有 `id` / `send` / `close` / `terminate?`，不带 appId、不带用户身份。准入是 Gateway/App 的业务。
NACT区分Client/Server，但提供给上层的语义不再区分，是全双工的。`listen`被连和 `dial`主动连只是构建 peer 的两条路，建完之后 peer 语义完全一致。


## 传输协议

三种承载各实现同一套入口，对上只产出统一 Peer：

```ts
type Transport = 'ws' | 'tcp' | 'unix'

listen(spec: TransportSpec, onPeer: (peer: Peer) => void): Promise<ServerHandle>  // 被连接时
dial(spec: TransportSpec): Promise<Peer>                                          // 主动连

interface ServerOptBase {
  compression?: CompressionKind   // CBOR 编码模式，预留位，NACT 尚未读
  heartbeat?: HeartbeatMs         // 心跳间隔 ms，不传取默认 30s，-1 关闭
  chunkSize?: number              // 本端向该连接发送时的分片阈值
}

type TransportSpec =
  | { type: 'ws';   opt: WSOpt }
  | { type: 'tcp';  opt: TCPOpt }
  | { type: 'unix'; opt: UnixOpt }

interface WSOpt   extends ServerOptBase { ip: string; port: number; path?: string }
interface TCPOpt  extends ServerOptBase { ip: string; port: number }
interface UnixOpt extends ServerOptBase { socketPath: string }


```

<!--AGENT_ATTENTION--  
三承载 peer 语义完全相同——同套 send/close/分片/清理，差异只在线缆并且封在实现里。unix 是一等承载，同机通信直接走 UNIX 域套接字，无网络栈开销。
NACT 只自行启动入口，不借用外部 server。`listen` 一律由 NACT 自己 `createServer` + `listen`，端口从此归它。ws 分支内部挂的 `http.Server` 同样是 NACT 自建的。
-->

<!--
> 曾经设想过一种「借外部已 listen 的 HTTP server 升级 ws」的形态，已废弃。原因不是难做，而是**那种场景根本不需要 NACT**：一个已经自己终结了 HTTP upgrade 的宿主（Nitro/h3 + crossws 之类）手里拿到的已经是一条建好的连接，NACT 在中间除了转发无事可做。那条路应当**直接跳过 NACT**，把自己的 Peer 交给 `NACP.inbound`。
>
> 代价要说清：跳过 NACT 同时也跳过了 CBOR 编解码、分片重组、心跳三件实事，宿主得自己补齐，否则同一个 NACP 会收到两种线格式的包。 
-->

<!--AGENT_ATTENTION-- 
- 两段状态机：无条件读满 32B 头 → 从 `thisFrameSize` 取 bodyLen → 读 body。头定长保证了总能先读满再决定 body 长度，无需外层长度前缀。framer 是 per-peer 状态。
- 帧上限 MAX_FRAME_SIZE = 2GiB：读出 thisFrameSize 立即校验，超限判定连接不可信。正常最大负载 embedding 200–400MB，2GiB 已是充裕余量。4GiB 上限的瓶颈在 cbor-x encode 而非 Node Buffer，见正文「关于 4GiB 上限」。
- decode 必须包 try/catch：脏字节或半帧导致 decode 抛异常时，若不捕获会在 data 回调里变成进程级 uncaught。
- 异常 = 强制断 + 发事件：超限或解码失败 → NACTError → 捕获 → emit nact:peer:error → close。NACT 只强制断，优雅挥手是 NACP 的事。
-->

分片的目的是穿透TCP/WebSocker中间层（如CDN）。tcp/ws 默认分片、单机 unix 默认不分片。

每条消息都带 32B 分片头，接收方据此自动重组，无需握手。

chunkSize 是本地发送策略、不协商，默认 unix 极大值不分片、tcp/ws 100MB。

### 分片头

```
[msgId:16B][offset:4B][totalSize:4B][thisFrameSize:4B][blank:2B][magicNumber:1B][NACTVersion:1B][payload:$thisFrameSize-32B]
   0..15      16..19      20..23         24..27         28..29        30            31
```

| 字段 | 宽 | v1 值 | 含义 |
|---|---|---|---|
| `msgId` | 16B | - | 同一逻辑消息所有片共享 |
| `offset` | 4B | — | 本片在整条消息中的起始字节 |
| `totalSize` | 4B | — | 整条消息长度。每片都带（冗余换任意片先到都能预分配 + 抗乱序） |
| `thisFrameSize` | 4B | — | **本片总长，含这 32B 头**，故 `bodyLen = thisFrameSize - 32`。头因此自定长，tcp/unix 不需要外层长度前缀 |
| `blank` | 2B | `0x0000` | 预留给未来的指示位 |
| `magicNumber` | 1B | `0xCF` | 魔数，随版本改变。|
| `NACTVersion` | 1B | `0x01` | NACT协议版本，位于头部最后一个Byte |

## 与 NACP 交互

NACT 对上暴露统一 Peer，格式如下：

```ts
interface Peer {
  id: NACTPeerId                // 物理连接 id
  send(msg: NACPMessage): void  // 发送给这个Peer消息
  close(): void                 // 优雅关闭
  terminate?(): void            // 强制断连
}
```

两层之间的耦合只有两个方法：

```
NACT → NACP    nact.host.deliver(msg, peer) -> napp.nacp.inbound(msg, peer)
NACP → NACT    napp.nacp.outbound(msg, opt?) -> napp.nact.sendToPeer(peerId, msg)
```

注意NACT不负责握手，只负责物理层面的链接。

## NACT API


```ts
new NACT(napp: NApp, codec: Codec = cborCodec)
```

| 方法 | 返回 | 说明 |
|---|---|---|
| `listen(spec, onPeer?)` | `Promise<ServerHandle>` | 按 spec 启动一个NAppServer |
| `dial(spec)` | `Promise<Peer>` | 主动拨号，连接到另一个NApp的NACT层 |
| `terminate()` | `Promise<void>` | NACT停机，关闭全部 peer 链接与全部 server 入口。|
| `addPeer(peer)` | `void` | 入表 |
| `getPeer(peerId)` | `Peer \| undefined` | 取 peer |
| `dropPeer(peerId)` | `boolean` | 出表。返回是否真的删掉了 |
| `listPeerId()` | `NACTPeerId[]` | 全部在表 peerId |
| `sendToPeer(peerId, msg)` | `boolean` | 按 peerId 发，若找不到 peer 则返回 `false`。 |
| `closePeer(peerId)` | `Promise<boolean>` | 优雅关闭指定连接，找不到该 peer 直接 resolve `false` |

<!--AGENT_ATTENTION--

### 内部状态

```
NACT
└── peerTable: PeerConnectionTable    peerIdPeerSheet: peerId → peer
```

NACT 只有一张表，传输抹平层的唯一状态落点。和 NACP 的四张表同构——一个对象套一张 sheet，不裸 Map。

表名与 NACP 的 `PeerAppConnectionTable` 刻意差一个 `App`：那张管 appId ↔ peerId 的**身份映射**，这张管 peerId → peer 的**连接持有**。appId 是 NACP 的概念，NACT 全程不碰。

没有第二张表。per-peer 的状态——framer 缓冲、重组表、心跳定时器——都活在 peer 自己的闭包里，随 peer 一起销毁，放进表只会给它们一次额外的泄漏机会。

出表只有一个写者：peer 工厂的 `gone` 回调。优雅关闭、传输故障、对端主动断，每条退出路径都汇到它：`dropPeer` 删除行记录后广播 `disconnect`。一行离表与被通告是同一次操作。

`gone` 仅当确实删除了那一行时广播（`if (this.dropPeer(peer.id)) emit`）。一条 peer 可能两次走到这里——故障时先 drop 再 terminate，承载随后又发 'close'——而 disconnect 必须恰好一次。NACP 靠这个事件清 appId 和订阅。

`terminate` 利用了这个性质：先 `clear` 整张表，随后到达的 'close' 事件找不到行可删，一条 disconnect 都不发。整层停机是 NApp 级的一个事件，不是 N 条 per-peer 断连。

-->




## NACT Event

NACT 不持有 bus。NACT 和 NACP 一样，都是监听并挂在 `NApp.EventBus` 上。

NACT 触发的事件一律以 `nact:` 开头：

| key | 触发时机 | payload |
|---|---|---|
| `nact:peer:connect` | 物理连接建立 | `{ peerId }` |
| `nact:peer:disconnect` | 物理断开 | `{ peerId }` |
| `nact:peer:error` | 传输故障，并强制断开peer | `{ peerId, reason }`，reason 取值见下表 |

`reason` 全部取值：

| reason | 触发条件 | 承载 |
|---|---|---|
| `version-mismatch` | 分片头末字节的 NACTVersion 不在 `MAGIC_BY_VERSION` 表里 | 全部 |
| `bad-magic` | 版本认识，但该版本的期望 magic 不匹配（损坏哨兵） | 全部 |
| `frame-too-large` | `thisFrameSize` > 2GiB | 全部 |
| `frame-too-small` | `thisFrameSize` < 32（tcp/unix）；整个 ws 帧 < 32B（ws） | 全部 |
| `frame-size-mismatch` | `thisFrameSize !== frag.length`，帧被截断或发送方 bug | 仅 ws |
| `decode-failed` | CBOR decode 抛异常 | 全部 |
| `reassembly-timeout` | 某 msgId 30s 内未收齐 | 全部 |
| `fragment-out-of-bounds` | `offset + bodyLen > totalSize` | 全部 |
| `overlapping-fragment` | 本片与已填区间交叠 | 全部 |
| `framer-error` | 状态机抛出但无具体 code 的兜底 | 仅 tcp/unix |
| `heartbeat-timeout` | 上个 ping 的 pong 未回而下个 ping 已到期 | 仅 ws |

NACT默认不监听NApp和NACP层的消息。

`nact:peer:connect` 只意味着链接已建立。register 握手还没发生，对端 appId 此时还是未知。

`nact:peer:disconnect` 是 NACP 清表的唯一触发源，NACP会订阅此事件，在断连发生时触发AppId和Peer在NACP层的凋零。

`nact:peer:error`后必定断开对应peer，因此error后一定伴随着一条`nact:peer:disconnect`。


## 备注

CBOR还有一个压缩参数，但不同语言的支持情况有异，该字段暂时保留未启用

NACT的有序保证是TCP、UnixSocket、WebSocket天生支持的。NACT没有单独实现发收包序列。


### 性能

- `encode` —— 发送端 `codec.encode` 单独计时
- `wire` —— 接收端**底层 socket 首字节**到重组完成，已扣除 decode。**必须用 raw socket 的首字节做起点**：ws 的 `'message'` 事件要等整帧被 ws 库重组完才触发（实测 300MB 帧滞后首字节 758ms），拿它计时会把整个接收过程排除在外
- `decode` —— 接收端 `codec.decode` 单独计时
- `peak` —— `process.memoryUsage().arrayBuffers` 峰值

「不分片」是强制 chunkSize = 2GiB 的对照组；

tcp/ws 默认 100MB 分片，unix 默认不分片。

| 承载 | payload | 分片 | wire | 接收端 peak |
|---|---|---|---|---|
| unix | 333MB | 不分片 | 278 | 333 MB |
| unix | 1GB | 不分片 | 665 | 1024 MB |
| unix | 1GB | 100MB × 11 | 668 | 1024 MB |
| tcp | 333MB | 不分片 | 289 | 333 MB |
| tcp | 1GB | 不分片 | 734 | 1024 MB |
| tcp | 1GB | 100MB × 11 | 667 | 1024 MB |
| ws | 333MB | 不分片 | 885 | 970 MB |
| ws | 1GB | 不分片 | 2784 | 3027 MB |
| ws | 1GB | 100MB × 11 | 3931 | **1147 MB** |

> 为什么是11片：
>
> 测试中Payload是完整的1GB，不是1GB-32Byte\*10。默认的切片策略有效paylaod大小是100MB-32B，所以最后会多出32B+32B\*10的数据用最后一个包发送。


<!--AGENT_ATTENTION-- 

### 关于 4GiB 上限

`totalSize` / `thisFrameSize` 都是 4B，字段本身到 4GiB。加宽这两个字段换不来 4GiB 以上——瓶颈在 cbor-x encode：

| 环节 | 实测上限 |
|---|---|
| `Buffer.allocUnsafe` | 远高于 4GiB（本机 8GiB 正常分配，`buffer.constants.MAX_LENGTH` 为 2^53-1） |
| **cbor-x encode** | **恰好 4GiB**（3.984 GiB 通过，4.000 GiB 抛出 `maximum buffer size`） |

要通过 4GiB，需让 encode 产物不再限于单个 Buffer——流式 encode/decode 或多缓冲拼接，属架构级改动。届时加宽字段是其中最容易的一步。

当前 `MAX_FRAME_SIZE = 2GiB` 是防 OOM 的护栏，比上述硬上限更早生效。正常负载 embedding 200–400MB，余量充足。

- 版本推进纪律：字节布局变化时 +1，同步改 magic。`MAGIC_BY_VERSION` 是表不是常量。不认识的版本 → `version-mismatch`；认识但 magic 不匹配 → `bad-magic`。两者都强制断。
- `blank@28` 是目前唯一预留位。曾考虑放在 totalSize 之后做加宽预留，但大端下紧随其后的 2B 是低位扩展，且加宽 totalSize 本身换不来 4GiB 以上。
- ws 侧 `thisFrameSize` 与 `frag.length` 做一致性检查：不匹配则 `frame-size-mismatch` + 强制断。发送方三承载一律照写该字段。
- 防重叠/重复：per msgId 维护已填区间集，每片校验在 `[0,totalSize)` 内且不与已填区间交叠。越界或交叠视为断言失败 → failPeer + close。
- 发送方单方决定分片：`32 + encode ≤ chunkSize` 不切，否则每片 body `≤ chunkSize - 32`。接收方永远剥 32B 头后 copy-in-place 重组。
- chunkSize 按 server 各设，connect 可覆盖。对端分片策略不受本端控制。配错导致中间层截断是运维责任，NACT 不保证穿透。
- 拷贝语义：接收方单拷贝——per msgId 预分配 totalSize buffer，每片 body.copy(dest, offset)，禁止 Buffer.concat。发送方 tcp/unix 两次 write，body 是 subarray 零拷贝；ws 必须 concat 一次才能交给 ws.send。
- 重组超时 REASSEMBLY_TIMEOUT_MS = 30000，超时未收齐释放 buffer 并 emit reassembly-timeout。
- 分片实测：tcp/unix 分片开销在 100MB 粒度下无法从噪声中区分。unix 默认不分片是因为同机无中间层。ws 分片 wire +41%、接收峰值 −62%，默认仍分片是为穿透 CDN 单帧上限和避免 3× payload 峰值。
-->


> 早期 `nry_shm.cpp` 采用「大 Buffer 塞共享内存、消息只带引用」的旁路已废弃，CBOR 让二进制直接进 payload 且无需 base64，旁路不再必要，连带砍掉 blob handle、生命周期、sweep、孤儿回收。同机优化就是选 unix 承载，对上层透明。


### 编解码

编解码只发生在传输边界，库为 cbor-x。

选型理由两条：

- **不用裸 JSON**：NACT-NACP-NASDK在Nyirusu实际应用时需要传输二进制（ImageEmbedding大约300-500MB），使用JSON只能ShareMemory或者base64。为了统一传输方式故采用CBOR直接快速编码为二进制。
- **不用 protobuf**：上层同时要“无 schema 自描述”和“原生二进制且 encoder 能遍历”，protobuf 二者只能得一。CBOR 的 map 一条消息内同时满足，是 IETF RFC 8949，无需 codegen。

实测数据 base64 总耗时是 CBOR 的 3~7 倍，且线上体积 +33%。


### 心跳与断线

心跳完全在 NACT 层、不进业务 type，上层不感知。

默认开启，间隔 30s。可在 TransportSpec 里传 `heartbeat` 覆盖 `-1` 关闭。

如果上一个心跳包还没回来，又该发下一个了，则NACT认为本链接断开。默认情况下断线超时即两倍间隔时间（默认60s）。

<!--AGENT_ATTENTION-- 
- ws 用原生 ping/pong 帧，不是 NACP 消息。判定命中则 `nact:peer:error` + reason `heartbeat-timeout` + 强制断。
- tcp/unix 把间隔交给 OS 层 TCP keepalive，探测和重试排期归操作系统，半开连接以一次普通 `close` 浮现。
-->



