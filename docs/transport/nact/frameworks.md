# Next.js 与 Nuxt Provider

这两个 Provider 使用现有框架路由承载 Streamable HTTP，不创建额外端口。它们的 `role` 是 `server`、`type` 是 `streamable-http`，因此客户端统一使用 `@chenyfan/nact-streamable-http-client`。

一个进程只初始化一个 NApp 和 Provider；不要为每个 GET、POST 新建实例。会话和正在运行的请求保存在该实例里。

## Next.js App Router

```bash
bun add @chenyfan/nasdk @chenyfan/nact-nextjs
```

在 `app/api/nacp/route.ts` 中：

```ts
import NApp from '@chenyfan/nasdk'
import NextJSProvider from '@chenyfan/nact-nextjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const provider = new NextJSProvider()
const app = new NApp({ id: 'next', server: [{
  type: 'streamable-http',
  provider: { maxSessions: 128, idleTimeoutMs: 120_000 },
}] })
app.nact.use(provider)
const ready = app.start()
const handlers = provider.routeHandlers()

export async function GET(request: Request) {
  await ready
  return handlers.GET(request)
}
export async function POST(request: Request) {
  await ready
  return handlers.POST(request)
}
export async function DELETE(request: Request) {
  await ready
  return handlers.DELETE(request)
}
```

`routeHandlers()` 返回绑定实例的函数，框架传入额外的 route context 不会影响处理。所有方法必须使用同一实例；开发热更新时建议使用 `globalThis` 缓存初始化 Promise，完整写法见仓库的 `examples/nextjs`。

框架依据具名方法导出建立路由，此处显式导出 GET/POST/DELETE。当前目标为常驻进程上的 App Router Route Handlers；不提供 Pages API 或 Server Actions 适配，也不承诺不同 Serverless 实例间共享会话。[Next.js Route Handler 官方接口](https://nextjs.org/docs/app/api-reference/file-conventions/route)

## Nuxt / Nitro

```bash
bun add @chenyfan/nasdk @chenyfan/nact-nuxt
```

本 Provider 面向 Nuxt 3/4 使用的 Nitro 2、H3 1 API，`h3` 是 peer dependency，首批目标为 `node-server` preset。

建立 `server/utils/nasdk.ts`：

```ts
import NApp from '@chenyfan/nasdk'
import NuxtProvider from '@chenyfan/nact-nuxt'

const provider = new NuxtProvider()
const app = new NApp({ id: 'nuxt', server: [{
  type: 'streamable-http', provider: { maxSessions: 128 },
}] })
app.nact.use(provider)
export const ready = app.start()
export { app, provider }
```

建立 `server/api/nacp.ts`（不带 `.get` 后缀，让同一路由接收所有方法）：

```ts
import { ready, provider } from '../utils/nasdk'
const handler = provider.handler()

export default defineEventHandler(async event => {
  await ready
  return handler(event)
})
```

在 `server/plugins/nasdk.ts` 绑定宿主关闭：

```ts
import { ready, app } from '../utils/nasdk'
export default defineNitroPlugin(async nitro => {
  await ready
  nitro.hooks.hook('close', () => app.terminate())
})
```

Provider 将 H3Event 转为 Web Request，并使用遵守背压的 stream pipeline 写回响应。宿主响应连接关闭时取消会话；先发送响应头，避免等待 NACP 注册造成循环等待。可运行示例见 `examples/nuxt`。[Nuxt 服务端路由约定](https://nuxt.com/docs/4.x/directory-structure/server)、[H3 请求转换](https://v1.h3.dev/utils/request)

## 通用约束

- 等待 `app.start()` 完成后处理路由请求；未开始或已关闭返回 503。
- `provider.handler()` / `routeHandlers()` 不负责 NApp 生命周期；宿主关闭时调用 `app.terminate()`。
- 认证、CORS 和会话限额配置见 [HTTP Stream](/transport/nact/http-stream)。不要缓存这些响应。
- 会话需要常驻内存和请求亲和；横向扩容、平台请求时限和代理缓冲需要在部署时明确配置。
- Node WebSocket upgrade、Edge runtime 和 H3 2 不是这两个适配器已实现的接入方式。
