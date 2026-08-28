# response

`response()` 向一次`request`/`(un)subscribe`/`(un)register`返回一次响应。

::: warning
一般业务不需要调用 `response()`。绑定的 Processor 会接收 Request，NACP也会自己处理Subscribe和Register事件，并自动发送最终响应。

该接口主要用于自定义 Processor、协议桥接或其他低层集成。
:::

## 使用

```ts
app.response(to, {
  parentId,
  isOk,
  whyNotOk?,
  kind?,
  decl?,
  payload?,
})
```

手动响应需要保留原 Request 的 `from` 和 `id`：

```js
const delivered = await app.response(request.from, {
  parentId: request.id,
  isOk: true,
  kind: request.meta.kind,
  payload: { result: 42 },
})
```

| 参数       | 说明                                    |
| ---------- | --------------------------------------- |
| `to`       | 原 Request 的发送方，即 `request.from`  |
| `parentId` | 原 Request 的 `id`                      |
| `isOk`     | 请求是否成功                            |
| `whyNotOk` | 失败原因，通常仅在 `isOk: false` 时提供 |
| `kind`     | 原请求类型：`"ability"` 或 `"event"`    |
| `decl`     | 随响应返回的 NApp 声明，通常不使用      |
| `payload`  | 返回给请求方的业务载荷                  |

失败响应示例：

```js
await app.response(request.from, {
  parentId: request.id,
  isOk: false,
  kind: request.meta.kind,
  whyNotOk: "invalid-input",
  payload: { message: "a 和 b 必须是数字" },
})
```

## 返回值

`response()` 返回 `Promise<boolean>`：

- `true`：响应已被目标确认。
- `false`：响应无法送达，例如没有可用路由。

`true` 只表示消息送达，不表示请求方已消费 `payload`。
