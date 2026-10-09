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
    heartbeatIntervalMs?: number | false, // 默认 60000
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

声明 NApp 对外的服务端入口。一个 NApp 可以同时提供多个入口，但必须在 `start()` 前注册每个 type 对应的 Server Provider：

```js
import WebSocketServerProvider from '@nyirusu/nact-websocket-server'

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

`nact.chunkSize` 是本地发送侧的分片阈值；省略时使用 Provider 声明的推荐默认值。链路存活由应用层心跳负责，见 [`opt.heartbeatIntervalMs`](#opt)。

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
这里的 `decl` 决定首次注册时交换的声明，也决定内嵌 `NApp.introduce` 能力返回的内容
:::

### opt

```ts
opt?: {
  isGateway?: boolean,
  autoMultiGatewayDowngrade?: boolean,
  ackTimeoutMs?: number,
  reconnectGraceMs?: number,
  heartbeatIntervalMs?: number | false,
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
| `heartbeatIntervalMs`       |      `60000` | 本端心跳周期；`false` 表示本端不发起    |
| `queueMaxBytes`             | `4294967296` | 单个出站队列的字节上限                  |
| `queueMaxCount`             |       `1024` | 单个出站队列的消息数上限                |

```js
opt: {
  isGateway: false,
  autoMultiGatewayDowngrade: false,
  ackTimeoutMs: 5000,
  reconnectGraceMs: 30000,
  heartbeatIntervalMs: 60000,
  queueMaxBytes: 1024 * 1024 * 1024,
  queueMaxCount: 512,
}
```

除非需要 Gateway、自定义故障判定或限制队列，保持默认即可。

默认开启的应用层心跳会周期性确认直连的 NApp 能否应答。`heartbeatIntervalMs` 是本端的周期，两端可以独立配置。需要调整时：

- `heartbeatIntervalMs: false`：本端不主动发起心跳，但仍会应答对端的心跳。它不影响对端；对端开启时会照常发心跳。两端都关闭时，空闲链路掉线要等到下一次发送失败或物理断开才会被发现。
- 周期越短发现越快，流量也越多。心跳失败会走 NACP 已有的离线判定，调周期时也要一起考虑 `ackTimeoutMs`。

:::details 心跳如何工作
心跳是一条普通的 `NApp.heartbeat` Ability Request，收到对应的完整 Response 才算完成；`isOk: false` 的 Response 也表明对端已应答。ACK 只表示消息送达，不能代替 Response。

注册成功后，拨号方立即发起，接受方安排半个周期后的首次发起。两端周期相同且应答及时的时候，发送时间通常错开约半个周期。收到对端的心跳 Request 可以提前本端下一次发送，但不能推迟原定时间；本端正在等待 Response 时不调整计时。

每次心跳从发出时开始计算下一周期。到期仍未收到 Response，就把对端转入 NACP 的离线流程；已经收到 Response 则发起新心跳。NACP 的 ACK 超时独立运行，两者谁先发现故障就先判离线。因此，周期短于 `ackTimeoutMs` 时，即使 ACK 也没有收到，下一周期的 Response 检查仍可能先触发。

离线时结束这条连接的心跳等待，重新注册后使用新的请求探测。旧心跳不跨连接补发，也不会影响新连接；普通业务请求仍按 NACP 的宽限与重连补发机制处理。

心跳只覆盖直连的对端（Gateway 本身也是直连，同样有心跳）。经 Gateway 到达的 NApp 不在本端链路表中，其存活由 Gateway 维持。`NApp.heartbeat` 由 NApp 自动注册到 Ability Processor；显式提供的 `decl` 即使不包含它，也不影响心跳执行。需要在能力声明中展示它时，再将其写入显式 `decl`。
:::

## 启动

```js
await app.start()
```

`start()` 会按每个 Spec 的 `type` 查找已注册 Server Provider，并启用所有 `server` 入口，随后允许连接到其他应用。缺失 Provider 时立即以 `provider-not-found` 失败。

:::warning
即使没有任何入口，也必须要start，否则无法启动和连接到其他应用。
:::

## 连接到其他应用

```js
import WebSocketClientProvider from '@nyirusu/nact-websocket-client'

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
