# subscribe

`subscribe()` 订阅另一个 NApp 的 EventBus 事件。

```js
const call = app.subscribe("core", "task:done")
```

:::danger
Subscribe能订阅的不仅仅只有`request`，也不仅仅有事件相关。

Subscribe设计就是能够直接订阅远程应用的**整个事件总线**，包括但不限于消息发出、事件执行。

是的，这可能会导致你订阅到**即将发出的`Notify`事件**，导致**消息海啸**！

具体内容详见 [`EventBus`](../eventbus) 章节。
:::

## 参数

```ts
app.subscribe(to, targetSubName, targetListener?)
```

| 参数             | 说明                     |
| ---------------- | ------------------------ |
| `to`             | 被订阅 NApp 的 `id`      |
| `targetSubName`  | 要订阅的 EventBus 事件名 |
| `targetListener` | 可选的通知回调           |

事件名支持单段通配符 `*`：

```js
const call = app.subscribe("core", "task:*")
```

:::info
`task:*` 可以匹配 `task:start` 和 `task:done`，但不会跨越多个 `:` 段。
:::

## 监听中途流

:::code-group

```js [使用回调函数]
const call = app.subscribe("core", "task:*", (message) => {
  console.log(message.meta.hitSubName, message.payload)
})

await call.response
```

```js [使用迭代器]
const call = app.subscribe("core", "task:*")
await call.response

for await (const message of call.stream) {
  console.log(message.payload)
  if (message.payload.done) break
}
```

:::

:::tip
如果使用迭代器，应当先等待 `response`，确认远端已建立订阅，再依赖后续通知。

这里的 `response` 只表示本次订阅是否建立，与其他 Request 是否结束无关。
:::

## 返回值与失败

`subscribe()` 返回订阅句柄：

| 字段       | 说明                                      |
| ---------- | ----------------------------------------- |
| `subId`    | 本次订阅的唯一 ID，可直接用于退订         |
| `response` | 远端确认订阅的 `Promise<ResponseMessage>` |
| `stream`   | `AsyncIterable<NotifyMessage>`            |

目标拒绝订阅或消息无法发出时，`response` 会 reject。

## 回调与迭代器载荷

回调与迭代器收到同一个完整的 [`NotifyMessage`](/transport/nacp/outbound/notify)：

```ts
(message: NotifyMessage) => void
```

| 字段                         | 说明                             |
| ---------------------------- | -------------------------------- |
| `message.from`               | 发送通知的 NApp                  |
| `message.meta.parentId`      | 本次订阅的 `subId`               |
| `message.meta.targetSubName` | 订阅时传入的事件名，可以包含 `*` |
| `message.meta.hitSubName`    | 本次实际命中的具体事件名         |
| `message.payload`            | 对端触发事件时携带的业务载荷     |

回调与迭代器可以同时使用，两者会收到同一批通知。

## 退出与缓存

退出 `for await` 迭代器循环会自动向远端发送退订（`break`或`return`都可以）。

如果只使用回调，则需要通过 [`unsubscribe()`](./unsubscribe) 手动退订。

:::tip
如果使用迭代器，NASDK会缓存未消费的内容。

上限由queueMaxCount决定。

溢出时会宣告`napp:internal:notify:warning`事件。
:::

:::warning
无论是Subscribe还是[`Request`](./request)，两者在接受流式Notify消息的表现基本是一致的。

- 只有迭代器能享受缓存，如果没有及时迭代，NASDK会暂时保留前`queueMaxCount`条消息。
- 回调没有缓存。这意味着在挂上缓存的时候极有可能会导致漏掉最开始的消息
- NACP内部有一个NotifyStream Table，每个App可以享受自己的独立缓存空间

两者差异点只有一个：Request迭代器退出后，默认不会取消订阅和终止Request。
:::
