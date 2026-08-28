# NAppOpts

```ts
new NApp({
  id: string,
  server?: [
    {
      type: "tcp",
      opt: {
        ip: string,
        port: number,
        heartbeat?: number,
        chunkSize?: number,
        compression?: "none" | "cbor-records",
      },
    },
    // 也可使用 ws 或 unix，详见下文
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

声明 NApp 对外监听的入口。一个 NApp 可以同时提供多个入口：

```js
server: [
  { type: "tcp", opt: { ip: "127.0.0.1", port: 18900 } },
  { type: "ws", opt: { ip: "127.0.0.1", port: 18901, path: "/nacp" } },
  { type: "unix", opt: { socketPath: "/tmp/world.sock" } },
]
```

| `type` | 必填地址     | 可选参数                                        |
| ------ | ------------ | ----------------------------------------------- |
| `tcp`  | `ip`、`port` | `heartbeat`、`chunkSize`、`compression`         |
| `ws`   | `ip`、`port` | `path`、`heartbeat`、`chunkSize`、`compression` |
| `unix` | `socketPath` | `heartbeat`、`chunkSize`、`compression`         |

`heartbeat: -1` 可关闭心跳；`chunkSize` 是本地发送侧的分片阈值，tcp和ws默认100M，unix不分包。

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

`start()` 会监听所有 `server` 入口，并允许连接到其他应用。

:::warning
即使没有任何入口，也必须要start，否则无法启动和连接到其他应用。
:::

## 连接到其他应用

```js
await app.connect("another-app-id", {
  type: "tcp",
  opt: { ip: "127.0.0.1", port: 18900 },
})
```

:::tip
到这里为止，一个完整的NApp框架已建立，可以正常与其他NApp链接并通讯。

但是，倘若不绑定Processor，这个NApp终究是空壳，无法真正去处理和执行任务。

有关Processor、NACAB和NACEB的内容，详见[任务与流水线](/workflow/)章节。
:::
