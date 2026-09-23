# 运行时接入

NASDK默认只提供CustomProvider接入。

若要在实际编写应用时接入已有的提供器，只需要单独安装后`nact.use`实际使用的Transport Provider即可。

:::tip
没有被安装和导入的Provider不会进入构建产物。

具体传输列表与基础用法见[底层传输](/transport/nact/transport)。
:::

## Web

Web环境不能主动监听端口，因此只使用Client Provider。

```bash
bun add @chenyfan/nasdk @chenyfan/nact-websocket-client
```

```ts
import NApp from '@chenyfan/nasdk'
import WebSocketClientProvider from '@chenyfan/nact-websocket-client'

const app = new NApp({ id: 'web' })

app.nact.use(new WebSocketClientProvider())
await app.start()
await app.connect('server', {
  type: 'websocket',
  provider: { url: 'wss://example.com/nacp' },
})
```

也可以安装`@chenyfan/nact-streamable-http-client`，使用二进制HTTP Stream和POST连接服务端。

## Node.js

Node.js可以使用Server Provider监听，也可以使用Client Provider主动连接。

只提供WebSocket监听：

```bash
bun add @chenyfan/nasdk @chenyfan/nact-websocket-server
```

同时监听和主动连接：

```bash
bun add \
  @chenyfan/nasdk \
  @chenyfan/nact-websocket-server \
  @chenyfan/nact-websocket-client
```

安装后分别注册即可：

```ts
import WebSocketServerProvider from '@chenyfan/nact-websocket-server'
import WebSocketClientProvider from '@chenyfan/nact-websocket-client'

app.nact.use(new WebSocketServerProvider())
app.nact.use(new WebSocketClientProvider())
```

TCP、Unix Socket和Streamable HTTP的使用方式相同，只需要替换安装和导入的Provider。

## Worker

Cloudflare Workers等运行时可以使用Web标准的Client Provider主动连接：

```bash
bun add @chenyfan/nasdk @chenyfan/nact-websocket-client
```

Worker没有自行`listen()`的过程。如果需要接收平台交付的Request或`WebSocketPair`，应由Worker完成路由与鉴权，再通过[自定义传输Provider](/transport/nact/provider)接入NACT。

## Serverless

Vercel Functions等Serverless运行时与Worker相同：

- 主动连接外部NApp时，安装对应的Client Provider。
- 接收平台交付的Request时，使用Custom Provider接入。
- 仅当平台允许持续二进制 Response、会话请求到达同一常驻实例，且实例寿命覆盖任务时，才适合当前 Streamable HTTP。

:::warning
Streamable HTTP需要在下行Stream与上行POST之间保持同一个session。

如果平台不能保证请求到达同一实例，需要由应用提供路由亲和（或者叫路由粘性）或外部会话协调。
:::

## 已有HTTP Server

已有Fastify、Hono、Nuxt、Next或其他HTTP Server时，不要再启动同端口的Server Provider。

Next.js App Router 使用 `@chenyfan/nact-nextjs`，Nuxt/Nitro 使用 `@chenyfan/nact-nuxt`。它们挂载现有路由，不再监听端口。示例与生命周期见[框架 Provider](/transport/nact/frameworks)。

其他 Fetch 兼容路由可以使用 `@chenyfan/nact-streamable-http-server/handler`。WebSocket upgrade 或其他宿主通道仍可通过 Custom Provider 接入。

:::details

## 构建与发布边界

NASDK core只包含NACT、Provider接口与Custom Provider，不依赖或转导出任何实际Transport Provider。

Provider必须由应用显式安装：

```bash
bun add @chenyfan/nasdk @chenyfan/nact-websocket-client
bun run build
```

构建过程不会自动下载Provider。应用应正常提交lockfile，保证缓存、离线构建与依赖版本可复现。

每个Provider包将`@chenyfan/nasdk`声明为peer dependency，避免安装第二份core。

浏览器和Worker构建只应导入Web兼容的Client Provider。Node.js专用Provider可以使用`node:*`，但不会被NASDK core或其他Provider转导出。

NASDK不提供`@chenyfan/nasdk/browser`、Cloudflare或Vercel专用core。平台差异只由应用实际导入的Provider和Custom接入代码决定。

:::
