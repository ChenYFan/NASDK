# NAppOpts

```ts
new NApp({
  id: string,
  server?: [
    {
      type: "websocket",
      provider: {
        host: string,
        port: number,
      },
      nact?: {
        chunkSize?: number,
      },
    },
    // 具体 type 和 provider 形状由安装的 Provider 包定义
  ],
  decl?: {
    events: { name: string, description: string }[],
    abilities: { name: string, description: string }[],
  },
  opt?: {
    isGateway?: boolean,                 // 默认 false
    autoMultiGatewayDowngrade?: boolean, // 默认 false
    ackTimeoutMs?: number,               // 默认 10000
    reconnectGraceMs?: number,           // 默认 120000
    queueMaxBytes?: number,               // 默认 4294967296 = 4GB
    queueMaxCount?: number,               // 默认 1024
  }
})
```

### id

> `id: string`

NApp 在网络中的唯一名称，也是其他 NApp 连接和发送消息时使用的目标名称。

不能为空，同一网络内不能重复。

```js
const app = new NApp({ id: "world" })
```

只设置 `id` 会创建一个不监听端口的 NApp。它仍需调用 `start()`，之后可主动连接其他 NApp。

### server

> `server?: TransportSpec[]`
> 默认值：`[]`

声明 NApp 对外监听的入口。一个 NApp 可以同时提供多个入口，但必须在 `start()` 前注册每个 type 对应的 Server Provider：

```js
const app = new NApp({
  id: 'world',
  server: [{
    type: 'websocket',
    provider: { host: '127.0.0.1', port: 18901, path: '/nacp' },
    nact: { chunkSize: 100 * 1024 * 1024 },
  }],
})

app.nact.use(new WebSocketServerProvider())
```

`type` 用于查找 Provider，`provider` 由对应 Provider 定义并原样接收，`nact` 只包含 NACT core 的连接选项。具体类型从 Provider 包导入，不由 NASDK core 维护所有物理地址的联合类型。

`nact.chunkSize` 是本地发送侧的分片阈值；省略时使用 Provider 声明的推荐默认值。heartbeat/keepalive 属于物理连接，放在 Provider 自己的配置中。

通常无需调整这些可选参数。

### decl

> `decl?: { events: { name: string, description: string }[], abilities: { name: string, description: string }[] }`

声明这个 NApp 提供的 Event 和 Ability。

通常省略，由绑定的 Processor 自动生成；显式填写时会覆盖自动生成结果。

```js
decl: {
  events: [],
  abilities: [{ name: 'appendWorld', description: '拼接 World!' }],
}
```

`decl` 只用于描述，不负责实现或处理请求。

::: tip
这个地方的decl会影响首次注册时和内嵌的`$introduce`能力
:::

### opt

```ts
opt?: {
  isGateway?: boolean,
  autoMultiGatewayDowngrade?: boolean,
  ackTimeoutMs?: number,
  reconnectGraceMs?: number,
  queueMaxBytes?: number,
  queueMaxCount?: number,
}
```

| 字段                        |       默认值 | 作用                                    |
| --------------------------- | -----------: | --------------------------------------- |
| `isGateway`                 |      `false` | 标记自己是否为Gateway                   |
| `autoMultiGatewayDowngrade` |      `false` | 遇到第二个 Gateway 时是否保留为普通连接 |
| `ackTimeoutMs`              |      `10000` | 等待 ACK 的最长阈值                     |
| `reconnectGraceMs`          |     `120000` | 断线后保留路由与排队消息的时间          |
| `queueMaxBytes`             | `4294967296` | 单个出站队列的字节上限                  |
| `queueMaxCount`             |       `1024` | 单个出站队列的消息数上限                |

```js
opt: {
  isGateway: false,
  autoMultiGatewayDowngrade: false,
  ackTimeoutMs: 5000,
  reconnectGraceMs: 30000,
  queueMaxBytes: 1024 * 1024 * 1024,
  queueMaxCount: 512,
}
```

除非需要 Gateway、自定义故障判定或限制队列，保持默认即可。

## 启动

```js
await app.start()
```

`start()` 会按每个 Spec 的 `type` 查找已注册 Server Provider，并监听所有 `server` 入口，随后允许连接到其他应用。缺失 Provider 时立即以 `provider-not-found` 失败。

:::warning
即使没有任何入口，也必须要start，否则无法启动和连接到其他应用。
:::

## 连接到其他应用

```js
import WebSocketClientProvider from '@chenyfan/nact-websocket-client'

app.nact.use(new WebSocketClientProvider())
await app.connect('another-app-id', {
  type: 'websocket',
  provider: { url: 'ws://127.0.0.1:18900/nacp' },
})
```

:::tip
到这里为止，一个完整的NApp框架已建立，可以正常与其他NApp链接并通讯。

但是，倘若不绑定Processor，这个NApp终究是空壳，无法真正去处理和执行任务。

有关Processor、NACAB和NACEB的内容，详见[任务与流水线](/workflow/)章节。
:::
