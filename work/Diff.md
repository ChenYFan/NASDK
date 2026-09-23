# NACT Transport Provider 待定边界

已确定方向：

- NACT 核心不再内置具体物理层实现；WebSocket、TCP、Unix Socket 分离为按需附着的子包。
- WebSocket、TCP、Unix Socket 分别发布独立子包。
- Provider 通过 NACT 实例注册表附着，并以 type 查找。
- 每种物理传输继续按 Server / Client 分包；角色只表示谁创建监听服务、谁主动连接，不表示数据方向。
- Server Provider 与 Client Provider 建连后都提供完整双向通信能力，并向 NACT 交付相同的双向字节通道。
- 增加可附着到已有宿主服务的 Custom Transport Provider。
- Custom Transport 需要能够承载 HTTP Stream + POST 这类上下行分离的传输。
- Streamable HTTP Server Provider 自建 HTTP Server，以二进制 HTTP Stream 下发、二进制 HTTP POST 接收；Client Provider 以 fetch Stream 接收、fetch POST 发送。
- NACT 分别维护 Server Provider 与 Client Provider 注册表；同一 type 的两种角色可只安装一个或同时安装。
- Custom Provider 不起 Server 也不主动连接。用户为宿主建立的每条逻辑连接调用 Custom 的建连入口，把宿主入站字节推入 Custom；NACT 出站字节通过用户提供的回调交回宿主。

## 构建与运行时待定

已确认现状：当前单包 `tsc` 构建全局启用 Node types，根包直接依赖 `ws`，NACT 内动态导入 `node:http`、`node:net` 与 `ws`；不能作为浏览器/Edge 兼容性的最终结构。

建议边界：

- NASDK core 只依赖 `Uint8Array`、Web Crypto、Timer、Promise/AsyncIterable 等通用能力，不导入 `node:*` 或具体 carrier。
- 每个 Provider 包独立构建和发布；应用通过 import 选择实际 Provider，不要求使用者按目标平台重新编译 NASDK。
- Client Provider 连接建立后与 Server Provider 使用完全相同的 send/receive 通道。
- 自建 Server Provider 才实现 `listen()`；Cloudflare Workers、Vercel Functions 等由平台交付请求的环境使用 Adapter/Custom，不伪装成 `listen()`。
- Web-standard Streamable HTTP Client 可复用于浏览器、Node、Cloudflare Worker 与 Vercel；自建 HTTP Server 实现留在 Node Server 包。
- Provider 的发送接口接收一个 fragment 的多个 byte chunks，允许 TCP/Unix 使用 vectored write，WS/HTTP 再按自身要求合并。
- Provider 同时提供 callback/push 与 AsyncIterable 两种入站读取 API；同一通道首次使用后锁定消费模式，不能混用。
- 不发布 browser、Cloudflare、Vercel 专属 NASDK core；平台差异由实际导入的 Provider/Custom 接入代码和应用 bundler 处理。
- Provider 必须独立安装，但 npm 的 `@chenyfan/nasdk/Foo` 是同一包的 subpath export，不能作为独立包安装。

待定：

1. Vercel 无常驻进程且实例可能横向扩缩；Streamable HTTP 服务端需要平台提供粘性会话/外部协调，具体部署条件仍需在实现后验证。

已确认：

- Provider 使用统一 `nact.use(provider)` 注册，由自身 role/type 进入对应注册表。
- 每个通道同时提供 callback 与 AsyncIterable 接收 API；两者读取同一字节源，正式接口仍需规定并发消费语义。
- NASDK 主包只导出 Provider SPI，不转导出任何具体 Provider。
- 每个具体 Provider 独立发布，例如 `@chenyfan/nact-websocket-server` 与 `@chenyfan/nact-websocket-client`；不使用集合包或主包 subpath。
- 每个 Provider 包默认导出唯一的运行时 Provider，并只命名导出自身 Options 类型；例如 `import WebSocketClientProvider, { type WebSocketClientOptions } from '@chenyfan/nact-websocket-client'`。
- `TransportSpec`、Provider SPI、Channel 与 Handle 等公共类型只由 NASDK core 导出。
- Channel 同时提供 callback 与 AsyncIterable 接收接口，但两种消费模式互斥；首次使用后锁定。
- CustomTransportProvider 随 NASDK core 提供。
- Streamable HTTP 固定使用 `application/octet-stream`：下行持续二进制 Response，上行二进制 POST；不支持 SSE、Base64 或 JSON 转换模式。
