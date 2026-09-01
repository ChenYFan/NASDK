# signal

`signal()` 向一个**进行中的 Event 请求**发送信号。

```js
const call = app.request("worker", {
  kind: "event",
  target: "countdown",
  payload: { from: 100 },
})

//[!code focus:11]
// 注入一条业务输入
await app.signal("worker", {
  parentId: call.reqId,
  kind: "normal",
  payload: { refrom: 200 }
})

// ...或者暂停 / 恢复 / 中止
await app.signal("worker", { parentId: call.reqId, kind: "pause" })
await app.signal("worker", { parentId: call.reqId, kind: "resume" })
await app.signal("worker", { parentId: call.reqId, kind: "abort" })
```

## 参数

```ts
app.signal(to, opt): Promise<boolean>
```

| 参数       | 说明                                                      |
| ---------- | --------------------------------------------------------- |
| `to`       | 目标 NApp 的 `id`                                         |
| `parentId` | 目标 Event request 的 `reqId`                             |
| `kind`     | 信号类型：`"normal"` / `"pause"` / `"resume"` / `"abort"` |
| `payload`  | 仅 `normal` 可带，随信号发送的业务载荷                    |

::: warning
Signal 只适用于**活跃的 Event 请求**。

发送`Signal`时，`parentId` 对应的Req若已结束，接受侧会报告错误 `processor-rejected`，但发送侧的返回仍是 `true`。

Ability 请求不需要也不会接收 Signal。
:::

## 返回值

`signal()` 返回 `Promise<boolean>`：

- `true`：消息送到了对端且对方已接受。
- `false`：Signal 无法送达。

## 更多

协议层的信封结构、接收方处理流程与去重语义，见 [NACP signal](/transport/nacp/outbound/signal)。
