# 自定义 Provider

需要接入其他物理传输、框架路由，或实现自己的鉴权策略时，可以自定义 Provider。

官方包与自定义包使用相同接口，通过 `app.nact.use()` 注册。

推荐以 [官方 Provider 源码](https://github.com/ChenYFan/NASDK/tree/main/packages)为模板重新实现，选择与目标传输、运行时接近的包即可。

:::warning
官方 Provider 只提供基础传输，不内置身份鉴权或完整的安全措施。

身份验证、访问控制和传输安全需要由应用、宿主或自定义 Provider 实现。

部分包提供 `authorize` 等回调，但不会自动完成鉴权。
:::

:::tip
除非你用了一个新的传输方式，或者需要在连接的时候完成鉴权，否则绝大多数情况下你只需要根据实际需求重新实现Server包即可。
:::

## Provider 接口

接口从 `@nyirusu/nasdk/NACT` 导入。

| 字段 | 说明 |
| --- | --- |
| `type` | 传输名称，与配置中的 `type` 对应 |
| `role` | `server` 接受连接，`client` 主动连接 |
| `defaultChunkSize` | 默认分片大小，不能超过载体允许的上限 |

Server 和 Client 分别实现以下入口：

```ts
interface ServerProvider<TType extends string, TOptions> {
  readonly type: TType
  readonly role: 'server'
  readonly defaultChunkSize: number
  listen(options: TOptions, accept: (channel: Channel) => void): Promise<ServerHandle>
}

interface ClientProvider<TType extends string, TOptions> {
  readonly type: TType
  readonly role: 'client'
  readonly defaultChunkSize: number
  dial(options: TOptions): Promise<Channel>
}

interface ServerHandle {
  close(): Promise<void>
}
```

- `provider` 配置原样传入 `options`。
- Server 每接受一条连接，调用一次 `accept(channel)`。可以自主监听，也可以附着到宿主。
- Client 在 `dial()` 成功时返回连接，失败时 reject。
- Server 关闭时停止接受连接、释放自身资源，附着式 Provider 不应反过来关闭宿主。

## Channel 接口

Channel 是交给 NACT 的一条双向通信连接：

```ts
interface Channel {
  send(frame: readonly Uint8Array[]): void | Promise<void>
  onReceive(handler: (frame: readonly Uint8Array[]) => void): () => void
  onClose(handler: () => void): () => void
  onError(handler: (reason: unknown) => void): () => void
  close(): void | Promise<void>
  terminate?(): void | Promise<void>
}
```

实现时只需关注以下规则：

- **发送**：一次 `send()` 是一帧，按数组顺序发送全部字节。返回或 Promise resolve 表示本端已接纳，不代表对端收到。无法接纳时请 throw 或 reject。
- **接收**：一次回调交出一帧。WebSocket 保留消息边界，TCP、HTTP Stream 等字节流需要切帧，可参考官方包使用 `makeFrameSplitter`。
- **内存**：交给 NACT 的字节不能再修改或复用，监听注册前到达的数据不能丢失。
- **事件**：监听方法返回取消监听的函数，关闭通知应当只触发一次，错误后仍需通知关闭。
- **关闭**：关闭后拒绝发送，并结束尚未完成的发送等待。`terminate()` 为可选的强制断开方法。

Provider 只负责二进制收发，不解析业务消息、不修改 NACT 帧头。

帧格式见 [NACT 分帧](/transport/nact/framing)。

## 注册与使用

实现自己的 Provider 后，按对应角色注册：

```ts
import NApp from '@nyirusu/nasdk'
import MyServerProvider from './my-provider'

const app = new NApp({
  id: 'MyApp',
  server: [{ type: 'my-transport', provider: { port: 11451 } }],
})
app.nact.use(new MyServerProvider())
await app.start()
```

Client 同样通过 `use()` 注册，在 `app.connect()` 中传入对应的 `type` 和 `provider` 配置。

同一 `role + type` 不可重复注册。

Server 与 Client 可以使用同一个 `type`。

## 鉴权与命名

Server 应在验证通过后才调用 `accept()`，拒绝时关闭连接。

Client 在建立连接时携带凭据。附着式接入也可以在宿主的升级或路由入口完成验证。

发布包时推荐沿用命名规则：

```text
nact-<传输方式>[-<平台>]-<client|server>
```

例如 `nact-websocket-nuxtjs-server` 的 `type` 为 `websocket-nuxtjs`。

默认导出 Provider，请将 `@nyirusu/nasdk` 声明为 peer dependency。
