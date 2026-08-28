# request

`request()` 向另一个 NApp 发起 Event 或 Ability 请求，并返回请求句柄。

```js
const call = app.request("world", {
  kind: "ability",
  target: "appendWorld",
  payload: { text: "Hello, " },
})

const response = await call.response
console.log(response.payload)
```

## 参数

```ts
app.request(to, {
  kind,
  target?,
  payload?,
  onProcess?,
})
```

| 参数        | 说明                                 |
| ----------- | ------------------------------------ |
| `to`        | 目标 NApp 的 `id`                    |
| `kind`      | 请求类型：`"ability"` 或 `"event"`   |
| `target`    | 要执行的 Ability 或 Event 名称       |
| `payload`   | 发送给目标的业务载荷                 |
| `onProcess` | Event 的过程结果回调，Ability 不使用 |

## Ability 请求

Ability 只有一个最终响应：

```js
const { reqId, response } = app.request("math", {
  kind: "ability",
  target: "add",
  payload: { a: 114514, b: 1805296 },
})

console.log(reqId)
console.log((await response).payload) // 1919810
```

## Event 请求

Event 除最终响应外，还可以返回过程消息流。

你可以使用 `onProcess` 回调或 AsyncIterator 读取过程消息。

两种方式都返回完整的 [`NotifyMessage`](/transport/nacp/outbound/notify)，和[`Subscribe`](./subscribe)基本一致。

:::info
request会自动订阅相关事件的Process流，并通过这两种方式允许用户读取。

详情参阅 [AutoSubscribe 机制](/transport/nacp/outbound/request/auto-subscribe)。
:::

### 使用回调

```js
const call = app.request("worker", {
  kind: "event",
  target: "countdown",
  payload: { from: 3 },
  onProcess: (message) => console.log(message.payload),
})

const result = await call.response
```

### 使用迭代器

```js
const call = app.request("worker", {
  kind: "event",
  target: "countdown",
  payload: { from: 3 },
})

for await (const message of call.stream) {
  console.log(message.payload)
}

const result = await call.response
```

:::tip
迭代器和回调的差异和细节内容基本与[Subscribe用法一致](./subscribe)。

不过request的迭代器中提前break**不会**中断原始流的进行。
:::

:::warning
需要注意，只有迭代器有队列，回调默认没有队列！

这意味着用回调的方式很有可能会漏掉最开始的几条消息。

[Subscribe](./subscribe)章节有对此完整解释。
:::

## 返回值与失败

所有请求句柄都具有以下参数：

| 字段       | 说明                                               |
| ---------- | -------------------------------------------------- |
| `reqId`    | 本次请求的唯一 ID                                  |
| `response` | 最终 `ResponseMessage` 的 Promise                  |
| `stream`   | 仅 Event 请求提供的 `AsyncIterable<NotifyMessage>` |

目标拒绝请求、处理失败或消息无法发出时，`response` 会 reject：

```js
const call = app.request("math", {
  kind: "ability",
  target: "unknown",
})
call.response.then(res => console.log).catch((e) => throw)
```
