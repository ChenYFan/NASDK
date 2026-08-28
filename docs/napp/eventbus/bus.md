# EventBus API

EventBus 可以独立创建，也可以通过 NApp 的 `app.bus` 使用。

```js
import { EventBus } from "@chenyfan/nasdk"

const bus = new EventBus()
```

## emit

发布事件，并同步分发给当前所有匹配的 Listener。

```ts
bus.emit(key, payload, thisArg?)
```

| 参数      | 说明                                       |
| --------- | ------------------------------------------ |
| `key`     | 具体事件名，不能包含 `*`                   |
| `payload` | 传给 Listener 的业务载荷                   |
| `thisArg` | 可选，作为本次 Listener callback 的 `this` |

```js
bus.emit("task:done", { taskId: "task-1" })
```

`emit()` 不返回 Listener 的结果，也不会等待异步 Listener 完成。

## listen

持续监听事件。

```ts
const listenerId = bus.listen(key, callback)
```

callback 的第二个参数 `hitKey` 是本次实际命中的事件名。每次 `listen()` 都会返回独立的 Listener ID。

```js
const listenerId = bus.listen("task:*", (payload, hitKey) => {
  console.log(hitKey, payload)
})
```

## listenOnce

监听一次事件，首次匹配后自动移除。

```ts
const listenerId = bus.listenOnce(key, callback)
```

返回的 Listener ID 可用于在事件触发前调用 `off()`。

## asyncListenOnce

以 Promise 等待一次事件。

```ts
const result = await bus.asyncListenOnce(key, callback?)
```

不提供 callback 时，Promise 返回事件载荷：

```js
const pending = bus.asyncListenOnce("task:done")
bus.emit("task:done", { result: 42 })

console.log((await pending).result)
```

提供 callback 时，Promise 返回 callback 的结果：

```js
const pending = bus.asyncListenOnce("task:done", (payload) => payload.result)

bus.emit("task:done", { result: 42 })
console.log(await pending) // 42
```

callback 抛错或返回 rejected Promise 时，`asyncListenOnce()` 会 reject。

## off

通过 Listener ID 解除监听。

```ts
const removed = bus.off(listenerId)
```

- `true`：Listener 已移除。
- `false`：Listener 不存在或已经移除。

## readonly

`bus.readonly` 返回只读的观察接口：

```js
const observer = bus.readonly

const listenerId = observer.listen("task:*", callback)
observer.off(listenerId)
```

它提供 `listen()`、`listenOnce()`、`asyncListenOnce()` 和 `off()`，不提供 `emit()`。

## readonlyView

`readonlyView()` 为传给 Listener 的 `thisArg` 提供浅层只读代理。

```js
import { readonlyView } from "@chenyfan/nasdk/EventBus"

bus.emit("task:done", payload, readonlyView(task))
```

它禁止修改、定义或删除根级属性，但不会递归保护嵌套对象。对象方法仍会绑定并调用原对象，因此也可能产生副作用。

## onError

普通 Listener 抛错或返回 rejected Promise 时，异常会交给 `onError`：

```js
bus.onError = (key, error) => {
  console.error(key, error)
}
```

异常不会中断其他 Listener，也不会由 `emit()` 向外抛出。

同一个事件桶超过 50 个 Listener 时，也会通过 `onError` 发出可能泄漏的提示。
