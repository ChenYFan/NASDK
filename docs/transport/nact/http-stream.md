# Streamable HTTP

`@chenyfan/nact-streamable-http-server` 与 `@chenyfan/nact-streamable-http-client` 把二进制 HTTP 下行流、有序 POST 上行绑定为一条双向 Channel。NACT 继续负责 CBOR、分片和重组，NACP 继续负责应用身份、ACK 和重连宽限。

## 独立服务

```bash
bun add @chenyfan/nasdk @chenyfan/nact-streamable-http-server
```

```ts
import NApp from '@chenyfan/nasdk'
import StreamableHTTPServerProvider from '@chenyfan/nact-streamable-http-server'

const provider = new StreamableHTTPServerProvider()
const app = new NApp({ id: 'server', server: [{
  type: 'streamable-http',
  provider: { host: '127.0.0.1', port: 18900, path: '/nacp' },
}] })
app.nact.use(provider)
await app.start()
```

`path` 默认 `/nacp`，其他路径返回 404。停机时调用 `app.terminate()`；关闭 Provider 的 handle 也会关闭所属的全部会话。

## 客户端

```bash
bun add @chenyfan/nasdk @chenyfan/nact-streamable-http-client
```

```ts
import NApp from '@chenyfan/nasdk'
import StreamableHTTPClientProvider from '@chenyfan/nact-streamable-http-client'

const client = new NApp({ id: 'client' })
client.nact.use(new StreamableHTTPClientProvider())
await client.start()
await client.connect('server', {
  type: 'streamable-http',
  provider: { url: 'http://127.0.0.1:18900/nacp' },
})
console.log((await client.request('server', {
  kind: 'ability', target: 'NApp.introduce',
}).response).payload)
await client.terminate()
```

浏览器与 Worker 使用相同 Client 包。它只依赖 Web Fetch/Streams，不导入 HTTP 服务端或 `node:*`。

## HTTP 会话协议 v1

| 请求 | 行为 |
| --- | --- |
| GET | 创建会话，返回 200、`x-nact-session` 和持续二进制 body |
| POST | 携带 `x-nact-session`，提交有限长度的二进制数据，成功返回 204 |
| DELETE | 携带 `x-nact-session`，关闭会话，成功返回 204 |

下行 body 首先发送固定 5 字节 `[0x4e, 0x41, 0x43, 0x54, 0x01]`，表示 HTTP 传输版本。这样即使宿主等待首个 body 才发送响应头，客户端也能拿到会话 ID 并发送 NACP Register。Client 剥离并验证这个前导；其后的每个字节都是原始 NACT 数据。POST 不带前导。

POST 使用 `Content-Type: application/octet-stream`。客户端串行发送 POST；一个 NACT Frame 可以跨多个 POST，多个下行 Frame 也可能被合并或拆分成任意网络块。Provider 不依赖 HTTP 块边界进行 NACT 解析。

同一会话的重叠 POST 返回 409，避免片段顺序歧义。空 POST 用于保活。未知或过期会话返回 404，不支持恢复旧 HTTP Stream；应用重新连接后，由 NACP 决定如何恢复应用关系。

## 资源与生命周期

Server 和框架 Provider 接受以下配置：

| 选项 | 默认 | 用途 |
| --- | --- | --- |
| `maxSessions` | 1024 | 同时存在的会话上限，满时 GET 返回 503 |
| `maxBodyBytes` | 4 MiB | 单次 POST body 上限，超过返回 413 并关闭会话 |
| `maxBufferedBytes` | 4 MiB | 每会话下行队列上限（最小 5 字节） |
| `idleTimeoutMs` | 120000 | 无上行或下行活动时关闭；0 禁用 |
| `authorize(request)` | 无 | 每次 HTTP 请求进入会话表前执行，可异步；false 返回 403 |

慢消费者导致下行队列溢出时，会话以 `send-buffer-overflow` 失败，不静默丢弃 NACT 字节。下行流被取消、GET 被中止、DELETE、空闲到期或服务关闭都会释放会话与计时器；正在读取的上行 body 也会取消。

Client 配置：

| 选项 | 默认 | 用途 |
| --- | --- | --- |
| `url` | 必填 | 完整路由 URL |
| `headers` / `credentials` | Fetch 默认 | 每次请求的认证信息与 Cookie 策略 |
| `fetch` | 全局 fetch | 注入 Fetch 实现 |
| `signal` | 无 | 取消整个连接 |
| `requestTimeoutMs` | 10000 | 建连响应头、每次 POST/DELETE 的等待上限 |
| `keepAliveMs` | 30000 | 空 POST 间隔；false 禁用 |
| `maxPostBytes` | 1 MiB | 把上行 Frame 拆成有限 POST body |
| `maxBufferedBytes` | 4 MiB | Client 接收与待发送字节队列上限 |

双方默认 `nact.chunkSize` 为 64 KiB。调大时应同时协调 `maxBufferedBytes`；Client 的 `maxPostBytes` 不应超过 Server 的 `maxBodyBytes`。HTTP 保活只维持物理会话，不替代 NACP ACK。

## 宿主、认证和部署

已有 Fetch 路由可以注册 `@chenyfan/nact-streamable-http-server/handler` 的默认 Provider：先通过 `app.start()` 或 `nact.listen()` 激活逻辑入口，再把请求交给 `provider.handle(request)`。该子入口不监听端口，也不导入服务端网络模块。

框架用法见 [Next.js 与 Nuxt](/transport/nact/frameworks)。所有请求必须到达持有会话的同一进程；多副本需要粘性路由。当前实现不提供跨实例会话存储，不能把普通无状态 Serverless 函数视为可直接替换的长连接宿主。

`x-nact-session` 是会话访问凭据，不能替代应用认证。生产入口由宿主提供 TLS、身份校验、Origin 策略和请求限流；`authorize` 可接入已有认证。跨域浏览器接入还需要宿主处理 OPTIONS、允许使用的认证头和 `x-nact-session`，并通过 `Access-Control-Expose-Headers` 暴露后者。Provider 不自动开放跨域。

反向代理必须允许二进制响应持续输出并关闭缓冲；Provider 设置 `Cache-Control: no-store, no-transform` 与 `X-Accel-Buffering: no`，代理配置仍由宿主负责。
