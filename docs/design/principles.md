# NASDK 设计准则

NASDK 是面向多应用通信与长时任务的通用运行时。

NASDK 期望应用之间可以通信，任务可以被编排，有限资源可以被协调，运行过程可以被观察和介入。

本文记录当前实现的核心方向、职责边界，以及下一批 Provider 的设计范围。计划中的能力会明确标注，不视为已经提供的保证。

## 应用身份独立于连接

NASDK 将一个能够独立运行并参与通信的程序称为 **NApp**。

NApp 使用稳定的 App ID 相互寻址，而不是直接依赖某条 WebSocket、TCP 或 Unix Socket 连接。

连接只是应用之间当前可用的传输路径。连接可以建立、断开和重建，应用身份及其正在进行的请求不应因此被重新定义。

这让业务代码可以面向目标应用发送消息，把连接管理、注册、路由和重连交给运行时处理。

## 协议独立于传输

NACP 定义 Request、Response、Subscribe、Notify、Signal 和 Ack 等应用语义，NACT 负责消息编码、分片重组以及具体传输承载。

两者保持分离，协议不关心消息经由 TCP、WebSocket 还是 Unix Socket 发送，传输层也不解释消息的业务含义。

物理传输进一步拆为独立 Provider：NACT core 只保留接口、Provider 注册、Peer 生命周期、编码和分片。Provider 不依赖 NApp 的应用身份表，不解释 NACP payload，也不自行重发业务消息。TCP/Unix 的 keepalive、HTTP 会话和 WebSocket 连接属于 Provider；ACK、请求配对与重连宽限属于 NACP。

Provider 通过 `role + type` 注册。Server 与 Client 表示谁负责监听、谁主动拨号；建连后的双方都可以发送和接收，不限制业务请求方向。框架 Server Provider 的 `listen()` 可以只激活宿主路由，而不创建操作系统监听端口。

这种分层让同一套应用 API 能够运行在不同环境中，也避免可靠性、路由和订阅关系散落到各个传输实现里。

## 通信与执行解耦

NACP 只负责把请求交给符合 Processor 契约的处理器，不理解请求内部的业务。NASDK 默认提供两类 Processor：

- NACAB 处理一次调用、一次返回的 Ability。
- NACEB 处理由 Event、Pipeline 和 Task 组成的多阶段任务。

应用可以替换 Processor，而不需要修改通信协议。相应地，NACEB 也不需要知道任务来自本地调用还是远程 NApp。通信解决“消息如何到达”，Processor 解决“工作如何执行”。

## 长时任务是一等公民

长时任务不仅有最终结果，还会产生过程输出，并可能在运行期间接收补充信息、暂停、恢复或终止。NASDK 因此不把所有工作压缩成一次普通 RPC，而是保留一次执行从进入队列到终结的完整身份和生命周期。

Event 表示一次完整任务，Pipeline 决定下一步执行什么，Task 完成一个具体动作。过程消息、Signal、SubEvent 和最终 Response 都围绕同一个执行关系组织，业务方不必额外维护一套相互独立的流式通道和控制通道。

## 资源约束属于调度层

GPU、模型实例和部分外部服务无法无限并发，但具体执行组件不应因此同时承担队列和资源调度职责。Task 可以声明执行所需的 `busyKeys`，由 NACEB 决定何时放行；TaskHandler 只负责完成一次具体执行。

资源竞争因而与任务生命周期统一管理，同时不侵入 Provider 或业务实现。没有资源冲突的任务仍可并发，等待网络或其他异步结果的步骤也不必占用无关资源。

## 可观测，也可介入

连接、消息、Event、Pipeline 和 Task 的关键状态转换都应当可以被观察。观察接口不应改变执行结果；观察者失败也不应阻断主流程。

对于确实需要控制运行过程的场景，NASDK 提供显式的 Signal 和生命周期 Hook。观察与介入使用明确的协议和状态边界，而不是让外部代码直接修改运行时内部对象。

## 保持语义克制

NASDK 是通用基础设施，不理解 Agent、Prompt、模型、工具调用或其他上层领域概念。这些语义应由建立在 NASDK 之上的框架或具体应用定义。

运行时只提供完成这些系统所需的通信、编排、资源协调和生命周期能力。保持这一边界，可以让 NASDK 服务于 AI Runtime，也可以用于任何需要多应用协作和长时工作流的系统。

## Channel 是字节与生命周期的边界

每个 Channel 对应一条逻辑双向连接。`send(chunks)` 的字节顺序必须保留，不能把 Frame 转成 JSON 或在通道中悄悄丢片。网络块可以拆分、合并，NACT 的流解析器恢复实际 Frame 边界。

NACT 按提交顺序串行等待异步 send。正常关闭等待已接受的发送排空，保证响应不会落在 close 之后；错误和强制停机则立即终止。Provider 必须把最终关闭或不可恢复错误传给 Channel，NACT 据此释放 Peer、重组缓存和观察回调。所有层都应容忍重复关闭，不重复宣告同一个 Peer 的离开。

Channel 提供 callback 和 AsyncIterable 两种读法，首次选择后不能混用。读流的消费者退出应释放占用的连接；错误应唤醒等待者，不能留下永久 pending 的 `next()`。

物理通道必须考虑资源边界。TCP/Unix 发送等待底层 write 完成；HTTP 限制会话数、单 POST 大小和下行缓冲；WebSocket 限制排队字节。字节流过载时终止连接并报告错误，不能使用过程消息队列那样的“丢最老一条”策略，否则会破坏后续所有 Frame。

## 宿主拥有路由和身份认证

独立 Server Provider 拥有它创建的监听服务。Next.js/Nuxt Provider 只拥有自身 HTTP 会话，不关闭整个框架服务器；端口、路由、TLS、CORS、认证和部署实例生命周期由宿主负责。

Custom Provider 用于应用已经持有的任意双向字节通道。框架有稳定的 Request/Response 接口时，应把共通的会话管理提取为可复用实现，再做薄适配层，而不是在每个框架重新维护 Framing、ACK 或应用路由。

HTTP session token 只用于把上下行绑定到同一个 Peer，不等同于已认证的 NApp 身份。认证必须发生在创建或访问会话之前。Provider 不默认开放跨域，也不把信任决策隐式放进 NACP 的 App ID。

## 可靠性的范围

ACK 表示消息在协议层被确认，不表示业务执行完成。最终 Response 才表达本次工作结果；过程 Notify 和 ACK 自身不再等待 ACK。Provider 的 send 成功也只表示传输层接受或写出数据，不表示远端业务已处理。

当前队列、去重记录、HTTP 会话和工作流状态均在内存中。重连宽限服务于存活进程中的连接恢复，不构成跨进程重启的持久化或全局 exactly-once 保证。需要持久化任务、跨实例会话或可重放业务副作用时，上层应显式提供相应机制。

## 下一批 Provider

| 接入 | 当前状态 | 设计方向 |
| --- | --- | --- |
| TCP、Unix Socket、WebSocket | 已实现独立 Server/Client 包 | 公共 Channel 契约与生命周期测试 |
| Streamable HTTP | 已实现 Server/Client、Fetch handler | 二进制 GET、顺序 POST、会话取消与限额 |
| Next.js App Router | 已实现 HTTP 路由适配 | 常驻进程、单例 NApp；Pages API/Edge 不在本批范围 |
| Nuxt / Nitro 2 | 已实现 H3 1、node-server 适配 | Nitro close hook 回收 NApp；H3 2 另行适配 |
| Hono / Fetch router | 可通过现有 `/handler` 接入 | 优先复用 Request/Response 接口，需要时再包装独立包 |
| Cloudflare Workers / Durable Objects | 设计候选 | WebSocketPair，或由 Durable Object 持有会话；先确定实例亲和和生命周期 |
| Electron IPC / MessagePort | 设计候选 | 二进制消息、transferable 的所有权、窗口销毁和端口关闭 |
| WebTransport / QUIC | 设计候选 | 优先有序可靠流；多流映射和 datagram 不能直接套用现有单字节流契约 |

新的 Provider 应先满足双向字节保真、发送顺序、故障收敛、资源上限、关闭清理和构建隔离，再扩展平台特性。计划中的连接方式不应提前写成已经发布的安装教程。
