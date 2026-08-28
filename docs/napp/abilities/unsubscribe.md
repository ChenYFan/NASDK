# unsubscribe

`unsubscribe()` 取消通过 [`subscribe()`](./subscribe) 建立的订阅。

```js
const call = app.subscribe("core", "task:*")
await call.response

const response = await app.unsubscribe("core", call.subId)
console.log(response.meta.isOk)
```

## 参数

```ts
app.unsubscribe(to, targetSubId)
```

| 参数          | 说明                               |
| ------------- | ---------------------------------- |
| `to`          | 被订阅 NApp 的 `id`                |
| `targetSubId` | `subscribe()` 返回的 `call.subId`  |

`to` 应与建立订阅时传给 `subscribe()` 的目标一致。

## 自动退订

使用迭代器读取订阅时，退出 `for await` 循环会自动退订：

```js
const call = app.subscribe("core", "task:*")
await call.response

for await (const message of call.stream) {
  console.log(message.payload)
  if (message.payload.done) break
}
```

只使用回调时不会自动退订，需要保存 `call.subId` 并手动调用 `unsubscribe()`。

## 返回值与失败

`unsubscribe()` 返回 `Promise<ResponseMessage>`。

本地监听会在调用时立即移除；`response` 表示远端是否确认删除订阅。

目标不可达、退订被拒绝或 `targetSubId` 不存在时，Promise 会 reject：

```js
try {
  await app.unsubscribe("core", call.subId)
} catch (error) {
  console.error(error)
}
```
