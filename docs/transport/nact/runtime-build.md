# 运行时接入

NASDK 是为跨平台、跨运行时设计的。

NASDK 将具体的物理传输方式拆成单独包，这意味着NASDK可以按需导入传输适配器，以在任何JSRuntime上完成通讯。

:::tip
没有被安装和导入的 Provider 不会进入构建产物。

具体传输列表与接入方式详见[传输 Provider](/transport/nact/provider)。

下列表格中的包名省略 `@nyirusu/nact-` 前缀。
:::

## Web Runtime

<table>
  <thead>
    <tr><th>包</th><th>可用</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td><code>websocket-client</code></td><td>✅</td><td>主动连接 WebSocket</td></tr>
    <tr><td><code>websocket-server</code></td><td>❌</td><td>浏览器不能监听端口</td></tr>
    <tr><td><code>streamable-http-client</code></td><td>✅</td><td>使用 Fetch</td></tr>
    <tr><td><code>streamable-http-server</code></td><td>❌</td><td>浏览器不能监听端口</td></tr>
    <tr><td><code>tcp-client</code></td><td>❌</td><td rowspan="4">浏览器不提供原始 Socket</td></tr>
    <tr><td><code>tcp-server</code></td><td>❌</td></tr>
    <tr><td><code>unix-client</code></td><td>❌</td></tr>
    <tr><td><code>unix-server</code></td><td>❌</td></tr>
  </tbody>
</table>

Web 环境目前没有可用的`Server`包，仅可以使用`websocket`与`streamable-http`。

```ts
import NApp from '@nyirusu/nasdk'
import WebSocketClientProvider from '@nyirusu/nact-websocket-client'
import StreamableHttpClientProvider from '@nyirusu/nact-streamable-http-client'

const app = new NApp({ id: 'web' })

app.nact.use(new WebSocketClientProvider())
app.nact.use(new StreamableHttpClientProvider())
```

## Node.js Runtime

<table>
  <thead>
    <tr><th>包</th><th>可用</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td><code>websocket-client</code></td><td>✅</td><td rowspan="8">Nodejs环境均可使用</td></tr>
    <tr><td><code>websocket-server</code></td><td>✅</td></tr>
    <tr><td><code>streamable-http-client</code></td><td>✅</td></tr>
    <tr><td><code>streamable-http-server</code></td><td>✅</td></tr>
    <tr><td><code>tcp-client</code></td><td>✅</td></tr>
    <tr><td><code>tcp-server</code></td><td>✅</td></tr>
    <tr><td><code>unix-client</code></td><td>✅（仅POSIX）</td></tr>
    <tr><td><code>unix-server</code></td><td>✅（仅POSIX）</td></tr>
  </tbody>
</table>

## Bun Runtime

使用 Node.js 兼容接口时沿用 Node.js 配置

若要使用原生 `Bun.serve()` ，可接入 `provider.fetch()` 完成StreamableHTTP附着。

暂时没有WebSocket附着形式。

```ts
import NApp from '@nyirusu/nasdk'
import StreamableHTTPServerProvider from '@nyirusu/nact-streamable-http-server'

const streamProvider = new StreamableHTTPServerProvider()
const app = new NApp({
  id: 'BunHttpApp',
  server: [{ type: 'streamable-http', provider: { noServer: true } }], // [!code focus]
})
app.nact.use(streamProvider)
await app.start()

Bun.serve({ // [!code focus:8]
  port: 18900,
  fetch(request) {
    if (new URL(request.url).pathname === '/nact@http')
      return streamProvider.fetch(request)
    return new Response(null, { status: 404 })
  },
})
```

## Express

<table>
  <thead>
    <tr><th>包</th><th>可用</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td><code>websocket-client</code></td><td>✅</td><td>主动连接</td></tr>
    <tr><td><code>websocket-server</code></td><td>✅</td><td>附着到 HTTP Server</td></tr>
    <tr><td><code>streamable-http-client</code></td><td>✅</td><td>使用 Fetch</td></tr>
    <tr><td><code>streamable-http-server</code></td><td>✅</td><td>附着到 Express 路由</td></tr>
    <tr><td><code>tcp-client</code></td><td>✅（需要底层Runtime支持）</td></tr>
    <tr><td><code>tcp-server</code></td><td>✅（需要底层Runtime支持）</td></tr>
    <tr><td><code>unix-client</code></td><td>✅（仅 POSIX）</td></tr>
    <tr><td><code>unix-server</code></td><td>✅（仅 POSIX）</td></tr>
  </tbody>
</table>


```ts
import express from 'express'
import http from 'node:http'
import NApp from '@nyirusu/nasdk'
import WebSocketServerProvider from '@nyirusu/nact-websocket-server'
import StreamableHTTPServerProvider, { toNodeHandler } from '@nyirusu/nact-streamable-http-server'

const web = express()
const httpServer = http.createServer(web) // [!code focus]

const streamProvider = new StreamableHTTPServerProvider()
const wsProvider = new WebSocketServerProvider()

const app = new NApp({
  id: 'ExpressApp',
  server: [
  {
    type: 'websocket',
    provider: { noServer: true }, // [!code focus]
  },
  {
    type: 'streamable-http',
    provider: { noServer: true }, // [!code focus]
  }]
})

app.nact.use(streamProvider)
app.nact.use(wsProvider)

await app.start()
// [!code focus:5]
//附着到WebSocket端点
wsProvider.attach(httpServer, { path: '/nact@ws' })
//附着到HTTP端点
web.all('/nact@http', toNodeHandler(streamProvider.fetch))

web.use(express.json())

httpServer.listen(18900) // [!code focus]
```


## Next.js

<table>
  <thead><tr><th>包</th><th>可用</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td><code>websocket-client</code></td><td>✅</td><td>主动连接</td></tr>
    <tr><td><code>websocket-server</code></td><td>✅</td><td>独立端口监听</td></tr>
    <tr><td><code>streamable-http-client</code></td><td>✅</td><td>使用 Fetch</td></tr>
    <tr><td><code>streamable-http-server</code></td><td>✅</td><td>Route Handler</td></tr>
    <tr><td><code>tcp-client</code></td><td>✅</td><td rowspan="2">需要底层 Runtime 支持</td></tr>
    <tr><td><code>tcp-server</code></td><td>✅</td></tr>
    <tr><td><code>unix-client</code></td><td>✅</td><td rowspan="2">仅 POSIX</td></tr>
    <tr><td><code>unix-server</code></td><td>✅</td></tr>
  </tbody>
</table>

### Streamable HTTP

:::code-group
```ts [app/nact@http/route.ts]
import NApp from '@nyirusu/nasdk'
import StreamableHTTPServerProvider from '@nyirusu/nact-streamable-http-server'

export const runtime = 'nodejs' // [!code focus]
const streamProvider = new StreamableHTTPServerProvider()
const app = new NApp({
  id: 'NextHttpApp',
  server: [{ type: 'streamable-http', provider: { noServer: true } }], // [!code focus]
})
app.nact.use(streamProvider)

const started = app.start() // [!code focus]

async function handle(request: Request) {// [!code focus:4]
  await started
  return streamProvider.fetch(request)
}
export { handle as GET, handle as POST } // [!code focus]
```
:::

### WebSocket

:::tip
NextJS WebSocket路由较为特殊，既没有直接开放HTTPServer供我们Upgrade，也没有提供足够的钩子实现WebSocketServer监听。

因此，目前NextJS只支持以`服务器`而非`附着器`形式的WebSocket Server。
:::

:::code-group
```ts [instrumentation.ts]
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { default: NApp } = await import('@nyirusu/nasdk')
  const { default: WebSocketServerProvider } = await import('@nyirusu/nact-websocket-server')

  const app = new NApp({
    id: 'NextWsApp',
    server: [{
      type: 'websocket',
      provider: { noServer: false, host: '127.0.0.1', port: 18901, path: '/nact@ws' }, // [!code focus]
    }],
  })
  app.nact.use(new WebSocketServerProvider()) // [!code focus]
  await app.start() // [!code focus]
}
```
:::


## Nuxt


<table>
  <thead><tr><th>包</th><th>可用</th><th>说明</th></tr></thead>
  <tbody>
    <tr><td><code>websocket-client</code></td><td>✅</td><td>主动连接</td></tr>
    <tr><td><code>websocket-server</code></td><td>✅</td><td>独立端口监听</td></tr>
    <tr><td><code>streamable-http-client</code></td><td>✅</td><td>使用 Fetch</td></tr>
    <tr><td><code>streamable-http-server</code></td><td>✅</td><td>H3 路由</td></tr>
    <tr><td><code>tcp-client</code></td><td>✅</td><td rowspan="2">需要底层 Runtime 支持</td></tr>
    <tr><td><code>tcp-server</code></td><td>✅</td></tr>
    <tr><td><code>unix-client</code></td><td>✅</td><td rowspan="2">仅 POSIX</td></tr>
    <tr><td><code>unix-server</code></td><td>✅</td></tr>
    <tr><td><code>websocket-nuxtjs-server</code></td><td>✅</td><td>Nitro专用包，通过原生 WS 路由实现</td></tr>
  </tbody>
</table>

### Streamable HTTP

:::code-group
```ts [server/routes/nact@http.ts]
import { defineEventHandler, toWebRequest, sendWebResponse } from 'h3'
import NApp from '@nyirusu/nasdk'
import StreamableHTTPServerProvider from '@nyirusu/nact-streamable-http-server'

const streamProvider = new StreamableHTTPServerProvider()
const app = new NApp({
  id: 'NuxtHttpApp',
  server: [{ type: 'streamable-http', provider: { noServer: true } }], // [!code focus]
})
app.nact.use(streamProvider)
const started = app.start() // [!code focus]

export default defineEventHandler(async event => { // [!code focus:4]
  await started
  return sendWebResponse(event, await streamProvider.fetch(toWebRequest(event)))
})
```
:::

### WebSocket

专用包 `@nyirusu/nact-websocket-nuxtjs-server` 可以让 Nitro 负责托管现有WS路由。

:::code-group
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  nitro: { experimental: { websocket: true } }
})
```

```ts [server/plugins/nasdk-websocket.ts]
import NApp from '@nyirusu/nasdk'
import NuxtWebSocketServerProvider from '@nyirusu/nact-websocket-nuxtjs-server'

export default defineNitroPlugin(async nitroApp => {
  const provider = new NuxtWebSocketServerProvider()
  const app = new NApp({
    id: 'NuxtWsApp',
    server: [{ type: 'websocket-nuxtjs' }],
  })
  app.nact.use(provider)
  await app.start()
  Object.assign(nitroApp, { nactWs: provider })
  nitroApp.hooks.hook('close', () => app.terminate())
})
```

```ts [server/routes/nact@ws.ts]
import { defineWebSocketHandler } from 'h3'
import type NuxtWebSocketServerProvider from '@nyirusu/nact-websocket-nuxtjs-server'

function hooks() {
  return (useNitroApp() as ReturnType<typeof useNitroApp> & {
    nactWs: NuxtWebSocketServerProvider
  }).nactWs.hooks
}
export default defineWebSocketHandler({
  upgrade: request => hooks().upgrade(request),
  open: peer => hooks().open(peer),
  message: (peer, message) => hooks().message(peer, message),
  close: (peer, details) => hooks().close(peer, details),
  error: (peer, reason) => hooks().error(peer, reason),
})
```
:::

当然，你也可以让标准WebSocketServer作为插件服务器，在nuxt启动时自主监听。
:::code-group
```ts [server/plugins/websocket.ts]
import NApp from '@nyirusu/nasdk'
import WebSocketServerProvider from '@nyirusu/nact-websocket-server'

export default defineNitroPlugin(async nitroApp => {
  const app = new NApp({
    id: 'NuxtWsApp',
    server: [{
      type: 'websocket',
      provider: { noServer: false, host: '127.0.0.1', port: 18901, path: '/nact@ws' }
    }],
  })
  app.nact.use(new WebSocketServerProvider())
  await app.start()
  nitroApp.hooks.hook('close', () => app.terminate())
})
```
:::
## CloudFlare Worker

<table>
  <thead>
    <tr><th>包</th><th>可用</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td><code>websocket-client</code></td><td>✅</td><td>主动连接 WebSocket</td></tr>
    <tr><td><code>websocket-server</code></td><td>❌</td><td>需要自主监听端口</td></tr>
    <tr><td><code>streamable-http-client</code></td><td>✅</td><td>使用 Fetch</td></tr>
    <tr><td><code>streamable-http-server</code></td><td>❌</td><td>需要自主监听端口</td></tr>
    <tr><td><code>tcp-client</code></td><td>✅</td><td>Worker可以正常出站TCP链接</td></tr>
    <tr><td><code>tcp-server</code></td><td>❌</td><td>不支持入站 TCP 监听</td></tr>
    <tr><td><code>unix-client</code></td><td>❌</td><td rowspan="2">不提供 Unix Socket</td></tr>
    <tr><td><code>unix-server</code></td><td>❌</td></tr>
    <tr><td><code>websocket-cloudflare-worker-server</code></td><td>✅</td><td>平台限定，通过附着到 fetch 路由完成通讯</td></tr>
  </tbody>
</table>

:::tip
NASDK目前没有打算为CloudFlareWorker提供对应的StreamableHTTP支持，原因是NASDK需要使用`Durable Object`实现状态保存。

WebSocket不需要DO，CFWorker的状态保存会随着链接维持。
:::

下面是一个简单的 echo Worker，返回原始输入和该连接的累计调用次数：

```ts
import NApp, { NACAB } from '@nyirusu/nasdk'
import WebSocketServerProvider from '@nyirusu/nact-websocket-cloudflare-worker-server'
let globalCount = 0
export default {
  async fetch(request: Request): Promise<Response> {

    //前置路由处理
    if (new URL(request.url).pathname !== '/nact@ws') return new Response('Not Found', { status: 404 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')  return new Response(null, { status: 426, headers: { Upgrade: 'websocket' } })

    //绑定物理传输
    const provider = new WebSocketServerProvider() // [!code focus]
    const app = new NApp({
      id: 'CloudFlareWebSocketEcho',
      server: [{ type: provider.type }], // [!code focus]
    })
    app.nact.use(provider) // [!code focus]

    //编写简单累加逻辑
    let connectionCount = 0
    const abilities = new NACAB()
    abilities.register({
      name: 'echo',
      description: '返回输入',
      execute: input => ({ echo: input, cCount: ++connectionCount, gCount: ++globalCount })
    })
    app.bindProcessor('ability', abilities.nacpAdaptor)

    //启动
    await app.start() // [!code focus]
    //返回由Provider包装好后升级的Response句柄
    return provider.fetch(request) // [!code focus]
  }
}
```

## Vercel Runtime


<table>
  <thead>
    <tr><th>包</th><th>可用</th><th>说明</th></tr>
  </thead>
  <tbody>
    <tr><td><code>websocket-client</code></td><td>✅</td><td>主动连接 WebSocket</td></tr>
    <tr><td><code>websocket-server</code></td><td>✅</td><td>本Provider可以附着到宿主 HTTP Server，导出给 Vercel</td></tr>
    <tr><td><code>streamable-http-client</code></td><td>✅</td><td>使用 Fetch</td></tr>
    <tr><td><code>streamable-http-server</code></td><td>❌</td><td>Vercel内存会话无法保证 GET 与 POST 跨实例路由后正常通信</td></tr>
    <tr><td><code>tcp-client</code></td><td>✅</td><td>使用 Node.js 出站 TCP</td></tr>
    <tr><td><code>tcp-server</code></td><td>❌</td><td>不提供公网入站 TCP 监听</td></tr>
    <tr><td><code>unix-client</code></td><td>❌</td><td rowspan="2">Vercel不提供 Unix Socket</td></tr>
    <tr><td><code>unix-server</code></td><td>❌</td></tr>
  </tbody>
</table>


```ts
import http from 'node:http' // [!code focus]
import NApp from '@nyirusu/nasdk'
import WebSocketServerProvider from '@nyirusu/nact-websocket-server'

const server = http.createServer() // [!code focus]
const wsProvider = new WebSocketServerProvider()
const app = new NApp({
  id: 'VercelWebSocketEcho',
  server: [{
    type: 'websocket',
    provider: { noServer: true }, // [!code focus]
  }],
})
app.nact.use(wsProvider)
await app.start()

wsProvider.attach(server, { path: '/nact@ws' }) // [!code focus]
export default server // [!code focus]
```
