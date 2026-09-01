# 底层传输

NACT 支持 WebSocket、TCP 和 Unix Socket 三种底层传输，并将其统一为 `NACT Peer`。

| 传输   | 适用场景                      | 地址                    |
| ------ | ----------------------------- | ----------------------- |
| `unix` | 同一台机器上的 Node.js 进程   | `socketPath`            |
| `tcp`  | 不需要 WebSocket 的跨机器通信 | `ip` + `port`           |
| `ws`   | 浏览器接入或CDN中继           | `ip` + `port` + `path?` |

## 如何选择

- 同机通信优先使用 Unix Socket。
- 跨机器、两端都是 Node.js 时使用 TCP。
- 任意一端是浏览器时使用 WebSocket。
- 需要经过 WebSocket 代理或网关时使用 WebSocket。

三种传输只影响连接方式，不改变 [NACT Framing](/transport/nact/framing)、NACPMessage 或上层协议语义。

## TransportSpec

```ts
type TransportSpec =
  | { type: "ws"; opt: WSOpt }
  | { type: "tcp"; opt: TCPOpt }
  | { type: "unix"; opt: UnixOpt }

interface WSOpt extends ServerOptBase {
  ip: string
  port: number
  path?: string
}

interface TCPOpt extends ServerOptBase {
  ip: string
  port: number
}

interface UnixOpt extends ServerOptBase {
  socketPath: string
}
```

同一个 `TransportSpec` 可用于监听和拨号：

```ts
await nact.listen(spec)
const peer = await nact.dial(spec)
```

:::warning
截止**NASDK v1.0.3** `listen()` 由 NACT 创建并持有对应 Server，暂时不能复用外部已有的 WebSocket Server。
:::

## 通用选项

```ts
interface ServerOptBase {
  heartbeat?: number
  chunkSize?: number
  compression?: "none" | "cbor-records"
}
```

| 选项          | 说明                                     |
| ------------- | ---------------------------------------- |
| `heartbeat`   | 心跳间隔，默认 30 秒；`-1` 关闭          |
| `chunkSize`   | 本端发送时的分片阈值                     |
| `compression` | 预留的 CBOR 编码选项，当前 NACT 尚未读取 |

默认 `chunkSize`：

| 传输   | 默认值  |
| ------ | ------- |
| `unix` | 2 GiB   |
| `tcp`  | 100 MiB |
| `ws`   | 100 MiB |

分片行为见 [NACT Framing](/transport/nact/framing)，连接与心跳行为见[生命周期](/transport/nact/lifecycle)。

## 浏览器

浏览器只能使用 WebSocket 主动拨号连接到其他NApp：

```ts
await nact.dial({
  type: "ws",
  opt: { ip: "127.0.0.1", port: 46080, path: "/nacp" },
})
```

浏览器调用 `listen()` 会抛出 `browser-no-server`，拨号 TCP 或 Unix Socket 会抛出 `browser-no-carrier`。

:::tip
浏览器只能作为WebSocket Client连接到其他NApp，但这并不影响NACP上层能力。

换句话说只要连接成功了，浏览器前端也可以作为完整NApp处理事件。
:::
