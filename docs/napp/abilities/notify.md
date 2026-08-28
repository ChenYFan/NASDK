# notify

`notify()` 向一个已知订阅直接发送 `NotifyMessage`。

:::warning
一般业务不需要调用 `notify()`。

远端通过 [`subscribe()`](./subscribe) 建立订阅后，在被订阅方调用 `app.bus.emit()`，NACP 会自动发送对应通知。

该接口主要用于自定义订阅实现、协议桥接或其他低层集成。
:::

:::danger
直接调用 `notify()` 不会在 `hitSubName` 对应的业务事件上执行 `app.bus.emit()`。

因此，它不会触发该业务事件的发送方本地 Listener。

不过，生成的 Notify 仍是标准 NACP 消息，出站时仍会在 `app.bus` 上发布 `nacp:outbound:notify` 观测事件。
:::

## 使用

```ts
app.notify(to, {
  parentId,
  targetSubName,
  hitSubName,
  payload?,
})
```

```js
const delivered = await app.notify("client", {
  parentId: subId,
  targetSubName: "task:*",
  hitSubName: "task:done",
  payload: { result: 42 },
})
```

| 参数            | 说明                             |
| --------------- | -------------------------------- |
| `to`            | 接收通知的 NApp `id`             |
| `parentId`      | 对应订阅的 `subId`               |
| `targetSubName` | 订阅时使用的事件名，可以包含 `*` |
| `hitSubName`    | 本次实际命中的具体事件名         |
| `payload`       | 随通知发送的业务载荷             |

`targetSubName` 与 `hitSubName` 在没有通配符时通常相同：

```js
await app.notify("client", {
  parentId: subId,
  targetSubName: "task:done",
  hitSubName: "task:done",
  payload: { result: 42 },
})
```

## 返回值

`notify()` 返回 `Promise<boolean>`：

- `true`：通知已经从发送队列发出。
- `false`：通知无法发出，例如没有可用路由。

:::danger
需要注意的是Notify默认不要求ACK。

因此这里返回的`true`仅代表消息已出站，不代表对方真的已收到或消费了`Notify`！
:::
