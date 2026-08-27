# NASDK EventBus

EventBus 是 NASDK 根级的通用事件总线。

每个组件 `new` 自己的独立实例，各自辖自己的事件命名空间。

它类似 EventEmitter，但是一个简化且做了特殊实现的变体。

## 快速开始

```ts
import { EventBus } from './EventBus.ts'

const bus = new EventBus()

const sub = bus.listen('user:login', (payload) => {
  console.log('user logged in:', payload.name)
})

bus.emit('user:login', { name: 'Alice' })   // → "user logged in: Alice"
bus.off(sub)
```

## key 格式与通配符

key 是冒号分段的字符串。**单段 `*` 匹配任意一个分段**。`*` 只在 listen 侧使用，emit 的 key 必须是具体值：

```
a:inbound:error:*          — 五段：a:inbound:error:timeout / a:inbound:error:auth
a:inbound:*                — 三段：a:inbound:error / a:inbound:request
a:inbound:*:event:*        — 五段且第三段为 event 时匹配
```

需要注意的是，EventBus没有 `**` 多段匹配。

每个 `*` 只匹配一段。通过分桶索引实现查找。

## 订阅

`new EventBus()` 的组件在内部使用完整 EventBus 实例进行 emit，对外暴露 `ReadonlyBus`[^2]，只有订阅/取消，不能 `emit`：

```ts
interface ReadonlyBus {
  listen(key: string, cb: (payload: any, hitKey: string) => void): string
  listenOnce(key: string, cb: (payload: any, hitKey: string) => void): string
  asyncListenOnce<R>(key: string, cb?: (this: any, payload: any) => R | Promise<R>): Promise<R>
  off(id: string): boolean
}
```

cb 的第二个参数 `hitKey` 是**本次实际命中的 key**。通配符订阅者只有它才能分清 `job:*` 这次是 `job:done` 还是 `job:failed`。

### `listen(key, cb)`

持续订阅。每次 emit 匹配的 key 都会触发 cb[^1]。返回本次订阅的 id[^4]，用完拿着这个 id 去手动 `off`。

```ts
const sub = bus.listen('order:paid', (payload) => {
  console.log('received payment:', payload.amount)
})

bus.emit('order:paid', { amount: 100 })
bus.emit('order:paid', { amount: 200 })  // cb 会再触发一次
```

> 每次 listen 都是一次独立的订阅，返回的 id 也不同。所以同一个 cb 挂两次就会触发两次，各自用各自的 id 取消。

### `listenOnce(key, cb)`

一次性订阅。触发一次后自动 remove 自己，不用手动 `off`。

同样返回订阅 id，用于「还没触发就想撤」的情况，触发过后这个 id 自然失效。

```ts
bus.listenOnce('connection:ready', (payload) => {
  console.log('connected to', payload.host)
})

bus.emit('connection:ready', { host: 'localhost' })
bus.emit('connection:ready', { host: 'remote' })  // cb 不再触发
```

### `asyncListenOnce(key, cb?)`

`await` 一次事件。本质是对`listenOnce`的额外Promise包装，会等待cb完全返回后将返回值作为resolve结果返回。

**cb 默认是 `(payload) => payload`**，即不传 cb 相当于默认返回payload。

cb 抛错或返回 rejected 会导致listen函数返回的Promise的整个reject，不会通过 `onError` 上报错误。[^3]

```ts
bus.emit('config:loaded:test', { version: 'v1.1.4.5.1.4' })

// 不传 cb：等价于直接返回 payload
const data = await bus.asyncListenOnce('config:loaded:*')
console.log(data.version)
// then写法也是可以的
const data$version = bus.asyncListenOnce('config:loaded:*').then((payload)=>payload.version).catch(e=>{})

// 如果传入了cb，会将cb的返回值作为resovle值
const cb_data$version = await bus.asyncListenOnce('config:loaded:test', (payload) => { return payload.version })
```

### `off(id)`

按订阅 id 取消订阅。把 `listen` / `listenOnce` 返回的那个 id 放进去即可。

返回 boolean 表示这次有没有真的摘掉一个订阅，`false` 意味着这个 id 已经失效了，可能已经 off 过、可能是 listenOnce 触发完自动摘了、也可能压根不存在。

```ts
const sub = bus.listen('key', (p) => console.log(p))
bus.off(sub)             // → true
bus.emit('key', null)    // cb 不再触发
bus.off(sub)             // → false，已经摘过了
```

## 发送

持有完整 `EventBus` 实例的一方负责 emit：

```ts
class EventBus {
  emit(key: string, payload: any, thisArg?: any): void
  onError: (key: string, err: unknown) => void
  get readonly(): ReadonlyBus
  // listen / listenOnce / asyncListenOnce / off 
}
```

### `emit(key, payload, thisArg?)`

- **`key`**：必须具体值，不含 `*`
- **`payload`**：cb 的第一个参数，传什么由 emit 方按约定决定
- **`thisArg`**：可选，成为此次所有匹配 listener 的 `this`。不传默认为 bus 自身

```ts
// 不传 thisArg 是内部this默认指向bus本身。
bus.emit('app:notification', { title: 'hello' })

// 传 thisArg 时，listen类函数内部的this会指向传入的内容
bus.emit('app:state:after', undefined, someObject)
// listen的cb可通过this.field读取到someObject.field

// 如果你希望listen不去修改传入的对象，可以用EventBus自带的readonlyView包装
bus.emit('app:state:after', undefined, readonlyView(someObject))
// 此时通过this.field=1修改将会抛出 TypeError
```

> readonlyView是EventBus导出的一个方法，通过Proxy包装阻止listen的cb误篡改this的内容。
>
> 但需要注意，这是**浅层**保护——只拦根级属性。以下三类修改仍然有效，不会抛错：
> - **嵌套对象**：`this.state.count++`、`this.payload.foo = 1`（嵌套对象是裸返回的，没有递归包装）
> - **方法调用**：`this.pause()`、`this.consume()`（方法会 `bind` 回真身，这是刻意保留的，否则观测者无法调用 consume 取结果）
> - 因此它准确的定位是「根级属性写保护的浅层代理」，不是「不可介入的观察视图」。
>
> 如果你需要严格隔离，应当自己传一个精简的 metadata 对象作为 thisArg，而不是依赖 readonlyView 包整个实例。

### `readonly`

`bus.readonly` 返回 `ReadonlyBus`，删除了 `emit` 能力，以保证外部获得的是一个只读视角的EventBus。

持有方把 readonly 暴露给外部消费者，自己保留完整 EventBus 的 emit 能力。见上文[订阅](#订阅)。

### `onError`

listener 抛错或 async reject 会触发 `bus.onError(key, err)`函数。

默认函数是空的 `()=>{}`，什么都不做。持有方应在构造时覆盖：

```ts
// 转回 EventBus 事件，观测面自己消化
bus.onError = (key, err) => bus.emit('app:runtime:error:bus', { key, error: err })
```

`onError` 还被用于 `maxListeners` 超标提示，见下节。

## 只读视图函数

```ts
readonlyView<T extends object>(target: T): T
```

这将返回一个包裹target对象的Proxy，并造成：
- 字段/getter 读将会被透传
- 方法调用将绑回真身
- set/delete/defineProperty将被拒绝并抛出TypeError。

该函数主要用于emit方用它把对象包成观测视图给 listener。

> 注意保护只有一层深：嵌套对象透传后不再包装（`v.state.x = 1` 有效），方法绑回真身后其副作用照常发生（`v.pause()` 有效）。见上文[emit](#emitkey-payload-thisarg)的说明。

## 异常隔离

所有的 listener 异常**不会中断后续 listener**，统一全部进 `onError`：

```ts
bus.listen('k', () => { throw new Error('A crashed') })
bus.listen('k', () => { console.log('B still runs') })
bus.emit('k', null)
// A → onError('k', Error('A crashed'))
// B → 'B still runs'
```

不过需要注意，asyncListenOnce的cb一旦出错会直接当场返回reject，不会在onError中上报。

## listener 数量限制

此限制是对于一个事件桶而不是全局监听器，默认 `maxListeners = 50`。

> 如果连接数超越 50 也不会报错，但是之后每增加一个链接都会通过 `onError(key, new Error('EventBus: N listeners on key — possible leak'))`提醒。

## 与 Node EventEmitter 的差异

| | EventEmitter | EventBus |
|---|---|---|
| 通配符 | 无 | 单段 `*` + 分桶索引 |
| listener 异常 | throw 中止后续 | 隔离进 `onError` |
| cb 的 `this` | 固定 emitter | emit 方传入，不传则默认 bus |
| 读写分离 | 无 | 通过`ReadonlyBus`访问eventbus将只能监听，不允许emit事件。 |

[^1]: callback 的简写。本文档中 cb 均指订阅时注册的回调函数。每次匹配的 key 被 emit 时触发，`this` 由 emit 方决定。

[^2]: `bus.readonly` 的返回值，`{ listen, listenOnce, asyncListenOnce, off }` 四个方法，不含 `emit`。

[^3]: 调用方是明确的去处，不需要走 `onError` 兜底。

[^4]: 形如 `sub_<uuid>` 的字符串。
