<!--AGENT_ATTENTION--
本文档内有一部分内容为了减少人类阅读负担，是仅AI可见的。
如果你是Agent，请非常严格地遵循注释为--AGENT_ATTENTION--的部分！
-->
# NApp

NApp 全称 Nyirusu Application，是 NASDK Facade，提供对NACP和NACT的包装能力，作为NASDK服务的入口存在。

NApp 与 [NACP](./nacp.md)、[NACT](./nact.md) 三者平行，同属 NASDK 直属成员。

NApp 仅在连接时区分Client/Server，在实际提供服务时不会。NApp之间的通信是全双工的，可以由任意一方发起连接。

<!--AGENT_ATTENTION--

## NASDK 构成

```
NASDK
├── EventBus.ts   自带事件总线，根级通用类，见 eventbus.md
├── types.ts      共享 Base：NASDKError + Processor 契约
├── utils/        共享工具类函数
├── NApp/         门面，用户配置入口（本文）
├── NACP/         协议层：信封格式 + 配对语义，见 nacp.md
├── NACT/         传输层：物理连接透明化，见 nact.md
├── NACEB/        内建 EventProcessor，见 naceb.md
└── NACAB/        内建 AbilityProcessor，见 nacab.md
```


NApp / NACP / NACT 三者平行，不要把 NACP、NACT 归到 NApp 底下。运行时三层一起 new、不分 C/S。代码只出现 `napp` / `naceb` / `nacab` 这些具象实例，`nasdk` 只在 import 路径里出现——NApp 就是 NASDK 具象化的表现。

NASDK 各层在构造时只接收一样东西：父层（NApp）的引用 `this.napp`。**没有私有能力盒**——NACP 曾经有一个 `NACPPrivateRef`，里面只装 `dispatch(kind)`，因为 `processors` 是 NApp 的 private 成员；那一项已改为 NApp 的 public `getProcessor(kind)`（公开的是查询，不是那张表，`bindProcessor` 仍是唯一入口）。于是 NACP 和 NACT 彻底对称，都只持 `this.napp`。兄弟之间交换的是方法不是对象：NACP 走 `this.napp.nact.sendToPeer`，NACT 走 `this.napp.nacp.inbound`，跨层在调用点上一目了然。一个共用 EventBus，`napp:*` / `nacp:*` / `nact:*` 事件都在上面。

NACEB / NACAB 各自 new 独立 EventBus，按实例区分不按能力区分——`app.bus` 归 NApp+NACP+NACT 这一组，NACEB/NACAB 各有自己的 `eventBusObs`（只读视图）。NACEB / NACAB 是可替换的，满足 `Processor` 契约即可挂入；NACP 只认契约、不认识具体类。空缺时 NApp 自动创建默认实例并公开在 `app.default`。


## 用词规范

- **NASDK**，Nyirusu Application SDK，通用传输调度框架的总称，缩写全大写。
- **NApp**，门面层类名，固定写 `NApp`。
- **App**，Application，这里一般指NApp实例，一个有独立生命周期的通信端：Core、Mem、Gateway、QQ、Web 等。
- **appId**，App 的逻辑名，全网唯一，字段统一 appId。
- **Processor**，满足 `list() + push()` 契约的 kind 处理器，ability 侧再加 `register()`。
- **Gateway**，`isGateway:true` 的那个 App，声明自己是NACP网关，支持Gateway转发能力。
-->

## 创建一个 NApp

```ts
import NApp from '@chenyfan/NASDK'

const app = new NApp({
  id: 'core',                          // appId，必填
  server: [                            // 要暴露的传输入口
    { type: 'unix', opt: { socketPath: '/tmp/core.sock' } },
    { type: 'ws',   opt: { port: 8080, ip: '127.0.0.1', path: '/ws' } },
  ],
  opt: {
    isGateway: false,                  // 本NApp是否作 Gateway
    autoMultiGatewayDowngrade: false,  // 遇到第二个声明 Gateway 的对端时选择降级保留还是断连
  }
})
```

注意，需要执行 `await app.start()` 才能开始启动本地Server、连接到其他应用。

<!--AGENT_ATTENTION--
**Gateway 是声明式的，只在这里声明一次**。`isGateway` 打开后收到 `to≠self` 的包会转发给真正的目标。谁是 Gateway 由它自己声明，连接双方从 register 交换里得知——`connect()` 不接受 gateway 参数，没有「本地把某连接当 Gateway」这回事。出站兜底槽位**先到先得**，第二个声明 Gateway 的对端由 `autoMultiGatewayDowngrade` 决定命运：

| 取值 | 行为 |
|---|---|
| `true` | 降级为普通连接：链路保留、能直连收发，只是不作兜底 |
| `false`（默认） | 视为组网错误：发 unregister、断开该连接，`connect()` 操作失败 |
-->

## 连接到其他 NApp

NApp 之间靠 `connect` 建立连接，握手成功后两端互相知道对方的 appId 和能力声明，之后才能交互消息

```ts
await app.connect('gateway', { type: 'unix', opt: { socketPath: '/tmp/gateway.sock' } })
await app.connect('mem',     { type: 'tcp',  opt: { ip: '127.0.0.1', port: 9001 } })
```

第一个参数是**你期望连到的 appId**，这个appId必须就是远端NApp自己设置的id，如果填错，远端NApp会认为这个包不属于自己，会直接丢弃。

> 注意！即使是连接到Gateway，appId也必须是Gateway的id！
>
> Gateway首先是标准NApp，然后有转发消息的能力。
>
> Gateway在收到register消息时，如果目标不是自己，会直接丢弃该包，不转发。

连上之后NApp会自动完成能力交换，之后可以直接向对端发送请求：

```ts
await app.connect('mem', { type: 'tcp', opt: { ip: '127.0.0.1', port: 9001 } })
const res = await app.request('mem', { kind: 'ability', target: 'kv.get', payload: { key: 'foo' } })
```

已连上的 NApp 可以用 `app.listConnectedApp()` 查询。




## 绑定处理器

Event 和 Ability 两种 kind 各需要一个处理器来处理具体的事件。

以下是完整的例子，包含了一个完整NApp计算冰雹函数的例子

```ts
import NApp, { NACEB, NACAB } from '@chenyfan/nasdk'
import { TaskHandler, PipelineHandler } from '@chenyfan/nasdk/NACEB'
import { AbilityHandler } from '@chenyfan/nasdk/NACAB'

const app = new NApp({
  id: 'core', 
  ...
})

class CollatzOdd extends TaskHandler {
  name = 'Collatz Odd'
  description = '冰雹函数奇数处理'
  async execute() { return this.input * 3 + 1 }
}

class CollatzEven extends TaskHandler {
  name = 'Collatz Even'
  description = '冰雹函数偶数处理'
  async execute() { return this.input / 2 }
}

class CollatzPipe extends PipelineHandler {
  name = 'Collatz'
  description = '冰雹函数'
  next(lastResult) {
    if (lastResult === undefined) {
      this.state.history = []
      lastResult = this.event.payload.inputNumber   // 首步：从 event 的 payload 取输入
    } else this.state.history.push(lastResult)
    if (lastResult === 1) return { task: '$terminal', input: { steps: this.state.history.length, history: this.state.history } }
    return lastResult % 2 === 0
      ? { task: 'Collatz Even', input: lastResult }
      : { task: 'Collatz Odd',  input: lastResult }
  }
}

// //NACAB部分也是类似的，这里随便给一个加法用例。
// class Add extends AbilityHandler {
//   name = 'math.add'
//   description = '两数相加'
//   async execute() { return this.input.a + this.input.b }
// }

const naceb = new NACEB({
  pipelineHandlers: [new CollatzPipe()],
  taskHandlers:     [new CollatzOdd(), new CollatzEven()],
  eventAlias: [
    { eventName: 'Collatz', pipelineName: 'Collatz', description: '算一次冰雹函数' },
  ],
})
const nacab = new NACAB({ 
  // handlers: [new Add()] 
})

app.bindProcessor('event',   naceb.nacpAdaptor)
app.bindProcessor('ability', nacab.nacpAdaptor)

```

`Processor`的两个处理器绑定**完全可以不使用默认的NACAB和NACEB**，只要符合以下接口形状：

```ts
import type { Processor, AbilityProcessor } from '@chenyfan/nasdk/types'

interface Processor {                                    
  list(): { name: string; description: string }[]        // 列出当前的能力和白名单事件入口
  push(spec, hooks): string | void                       // 事件、能力请求的激活入口
}

interface EventProcessor extends Processor {}

interface AbilityProcessor extends Processor {           
  register(item: { name, description, execute(payload) }): void // 仅 ability 侧多这一个register函数
}

spec  = { target: string, payload: any, reqId: string }  // target 是事件/能力名，reqId 是请求id
hooks = {
  onResponse(result, isOk, whyNotOk?),   
  onProcess(chunk),                      // 过程流，调 0~N 次。ability激活时本hook不会被调用。
}
```


Ability侧必须实现`register`，NApp会将自己的一部分能力在启动时以`NApp.`前缀注册进去。Event侧没有这个需求。

两个处理器必须在 `await app.start()` 之前绑定。如果在start时NApp发现自己没有对应的处理器，会自动绑定空白的 NACEB / NACAB 并把实例挂载在`app.default.*`供外部修改。

当`onResponse`被激活时，就意味着本次请求正式结束。此时NASDK会自动解除本事件的监听器，onProcess会直接失效。


## 请求与结果

绑定Processor之后，当这名为`core`的NApp连接到其他NApp时，其他的NApp就可以向他发起一个请求。

```ts
// 对端：算 27 的冰雹函数（event，有过程流）
const res = await peer.request('core', {
  kind: 'event', target: 'Collatz', payload: { inputNumber: 27 },
  onProcess: (chunk) => console.log('中间值：', chunk),
})
console.log(res.payload)   // => { steps: 111, history: [...] }

// 对端：加法（ability，无过程流）
const sum = await peer.request('core', { kind: 'ability', target: 'math.add', payload: { a: 1, b: 2 } })
console.log(sum.payload)   // => 3
```

Request自动订阅流机制名为Auto-Sub，详情见[NACP - sendRequest](./nacp.md#sendRequest)部分。

<!--AGENT_ATTENTION--
两个 kind 必绑的原因是 register 要带 `decl`，而 `buildDecl()` 从 Processor 的 `list()` 现算——没绑就声明不出东西。`ensureProcessors()` 只在 `start()` 里调一次；`connect()` 不再自己兜，因为它已经要求 `started`。这是刻意收敛：以前 `connect()` 也兜一次，为的是让纯 client App 免调 `start()`，现在改成全网一条启动顺序。

`started` 标志由 `start()` 置位，`connect()` 检查它，没置位抛 `nappInternal('not-started')`。`start()` 自身幂等（`if (this.started) return`），不会重复 listen。

event 侧没有 `register` 不是遗漏：一个 event 的实现体不是单个可调用物，NACEB 要把 event 名解析成一条 pipeline，`register(item)` 在那边没有能指。

`push` 的返回值（NACEB 会返 eventId）NACP 故意不接——两层 id 隔离，NACP 只认 reqId。

NACEB / NACAB 满足契约的方式是各自暴露一个 `nacpAdaptor` 子部件，处理器主体不认识 NACP 词汇。自己写处理器不必照抄这个结构，直接让对象本身满足契约也行。
-->


<!--DRAFT-->

## 订阅与通知

在上文请求与结果时，你可以在发送request时写入一个回调函数。在有过程流时NACP会通过NApp的唯一过程订阅流上报消息。

实际上，NApp还提供了部分原语来实现NApp层的订阅：

```ts
// subscribe默认返回[Promise<ResponseMessage>, AsyncIterable<any>]
// AsyncStream模式可以通过流式await第二个AsyncIterable来实现输出
const [sub, stream] = app.subscribe('core', 'naceb:event:done:after:*')
for await (const chunk of stream) {
  console.log(chunk)
  if (chunk.last) break          // break 则会触发 Unsubscribe
}

// 也可以通过传入具体的回调参数来实现回调，但这必须要主动unsubscribe
const [sub] = app.subscribe('core', 'naceb:event:done:after:*', (payload, msg) => {
  console.log(payload, msg.meta.hitSubName)   // hitSubName = 实际命中的具体事件名
})
const res = await sub
await app.unsubscribe('core', (res.payload as SubscribeResponsePayload).targetSubId)
```

回调和 `stream` 是共存的，同一条 notify 两边都收得到。

默认情况下NASDK会对AsyncStream保留缓冲区，以允许接受侧背压或者延迟接收。此外AsyncStream中如果采用break/return或者报错也会视为自动`unsubscribe`。

缓冲区是有限的，还没开始 `for await` 时到达的 notify 会被缓冲，迭代一开始先按序回放。

缓冲上限 1024 条，超出了会丢弃最旧的一条并发一条警告 `napp:internal:notify:warning`（`reason: 'stream-overflow'`）。

<!--AGENT_ATTENTION--

返回元组而不是对象，是因为两半的就绪时刻本质不同：`stream` 同步可用（ListenTable 记录在 subscribe 出站前就 add 了），`sub` 必须等 response。用同一种形状包装会掩盖这个差异，而这个差异正是「不漏包」的来源。

退订要的 id 由被订方写在 ack 的 `payload.targetSubId`（`SubscribeResponsePayload`），名字就是 `unsubscribe` 的入参名，拿到直接传回去。

**subId 不是任何一侧能决定的东西**，永远是「那条已经跨过线的消息的 id」：真实 subscribe 用 subscribe 消息自己的 `msg.id`（被订方 `onSubscribe` 里 `subId = msg.id`，并把它写进每条 notify 的 `parentId`）；AutoSub 用 request 的 id（也不是自造，是请求方铸、接收方从 request 上读到的，双方本就共知）。所以 `NApp.subscribe` 不能本地 `uid()` 一个——那样每条 notify 都会 `has-no-consumer`。NACP 通过 `opt.onSubId` 在出站前同步把它用的 subId 递出来，供 stream 建 cancel 路径（`break` 可能早于 response 到达）。

流的终结只有一个写者：ListenTable 记录离表时触发 `ListenRecord.onEnd`。四条离表路径（unsubscribe / `_cleanupPeer` 断连 / `terminate` clear / subscribe 失败回滚）全部经过 `ListenTable.end()`，所以「订阅没了」和「流结束了」是同一件事，不需要在四处各挂一次。`end()` 幂等。

已缓冲的 chunk 在 `end()` 之后仍会被排空才退出循环——终结不等于丢弃。

`NotifyStream` 是个通用的有界 push-to-pull 队列，放在 NApp/ 只因为只有这一层往外发它（NACP 只管把 notify 交给回调，对迭代没有意见）。
-->

### 默认能力

NApp通过在Ability中注册能力，以允许NApp内建的能力能够通过自身标准通讯NACP协议完成数据交换和远程调用。

| 名字 | 作用 |
|---|---|
| `NApp.introduce` | 返回本 App 完整能力声明 |

App 自建的能力一律以 `NApp.` 开头。

## API

当构建NApp后，NApp会公开以下能力：

<table class="hooks">
<tr><th>归属</th><th>方法</th><th>返回</th><th>说明</th></tr>

<tr><td class="st" rowspan="4">生命周期</td>
    <td><code>start()</code></td><td><code>Promise&lt;void&gt;</code></td>
    <td>NApp正式启动，开始监听对应的server路径。</td></tr>
<tr><td><code>connect(expect, target)</code></td><td><code>Promise&lt;void&gt;</code></td>
    <td>连接到对端NApp。必须在start后才能连接。</td></tr>
  <tr><td><code>disconnect(appId)</code></td><td><code>Promise&lt;boolean&gt;</code></td>
    <td>主动断开一个对端NApp。</td></tr>
<tr><td><code>terminate()</code></td><td><code>Promise&lt;void&gt;</code></td>
    <td>关停整个 NApp，向所有对端发送注销消息，之后关闭全部 server 入口</td></tr>

<tr><td class="st" rowspan="5">发送消息</td>
    <td><code>request(to, opt)</code></td><td><code>Promise&lt;ResponseMessage&gt;</code></td>
    <td>向对端发送request消息，可以在<code>opt.onProcess</code>编写回调函数接受过程通知。</td></tr>
<tr><td><code>subscribe(to, name, listener?)</code></td><td><code>[Promise&lt;ResponseMessage&gt;, AsyncIterable]</code></td>
    <td>远程订阅消息。详情见订阅与通知。</td></tr>
<tr><td><code>unsubscribe(to, subId)</code></td><td><code>Promise&lt;ResponseMessage&gt;</code></td>
    <td>远程取消订阅。</td></tr>
<tr><td><code>notify(to, opt)</code></td><td><code>Promise&lt;boolean&gt;</code></td>
    <td>单向推送消息。</td></tr>
<tr><td><code>response(to, opt)</code></td><td><code>Promise&lt;boolean&gt;</code></td>
    <td>向远程NApp发送响应消息。一般不建议这么使用，这可能会导致NApp内部状态错误。</td></tr>

<tr><td class="st" rowspan="2">观测</td>
    <td><code>bus</code></td><td><code>EventBus</code></td>
    <td>即EventBus，注意这个bus是非只读的。</td></tr>
<tr><td><code>listConnectedApp()</code></td><td><code>string[]</code></td><td>列出当前已连接的NApp</td></tr>

<tr><td class="st" rowspan="2">装配</td>
    <td><code>bindProcessor(kind, proc)</code></td><td><code>void</code></td>
    <td>绑定对应的Processor处理器</td></tr>
<tr><td><code>buildDecl()</code></td><td><code>Declaration</code></td>
    <td>计算本NApp的事件链表和能力。</td></tr>
</table>


<!--AGENT_ATTENTION--
`notify` / `response` 的 `false` 有四种来源：`self-addressed` / `no-route` / `send-failed`（三者都发 `nacp:internal:route:error`），以及门面层 `stopping` 闩直接返 false（不进 NACP）。其余三个出站方法靠 response 的 `isOk` 表达成败，不需要这个布尔。

`subscribe` 第三参叫 `targetListener` 不叫 `onNotify`，避免和入站族的 `NACP.onNotify` 撞名；它拿 `(payload, msg)`，不传等于 `() => {}`。

门面上的订阅永远是显式订阅：AutoSub 四个半边都不出 NACP，所以 `NApp.subscribe`/`unsubscribe` 不需要 `| void` 分支，而 `NACP` 同名方法有。

`response` 即使没发出去，AutoSub 的撤订也照样执行——被撤的那半边 SubscribeTable 记录是本端的。

`listConnectedApp` 是 `nacp.listAppId` 的一行转发。`app.bus` 是 NApp 自己 new 的完整 EventBus（带 emit，刻意的：宿主可能要把自己的信号并进同一条观测流）。

**NApp 现在会 emit 了**，只有一条：`napp:internal:notify:warning`（订阅流缓冲溢出丢包）。这是唯一一件只有门面知道、下层看不见的事——NACP 把 notify 交给回调就完事了，丢包发生在门面自己的队列里。其余 App 级事实仍由拥有它的那层发（`nacp:internal:napp:success` 等），不在这里重复一遍。

四个生命周期动词是两对，粒度不同：`start` ⇄ `terminate` 管整个 App，`connect` ⇄ `disconnect` 管一个对端。

`disconnect(appId)` 两步：`nacp.unregister(appId)`（**吞掉 rejection**——对端已死或超时不答都不该阻止关 socket）→ `nact.closePeer(peerId)`。**不显式清 NACP 的表**：那件事搭 `nact:peer:disconnect` 的车，第二步自然产生它，于是「主动断开」和「网线被拔」走完全同一条清理路径。查不到 peerId 直接返 `false`。

`terminate()` 的四步：latch stopping（不可逆，同时是重入闩）→ `allSettled` 发 unregister → `nacp.terminate()` → `nact.terminate()`。第二三步顺序是硬的，反过来道别就发不出去了。
-->

## 观测

### 内部事件

NApp 持有一个共用 EventBus（`app.bus`），NApp、NACP 和 NACT 的所有内部事件都在上面。

```ts
app.bus.listen('nacp:inbound:*', ({ msg }) => {})
app.bus.listen('nacp:internal:napp:success', ({ appId, reason, isGateway }) => {})  // reason: bound | dropped
app.bus.listen('nact:peer:connect', ({ peerId }) => {})
app.bus.listen('nacp:internal:gateway:*', ({ msg, reason }) => {})

const listenId = app.bus.listen('nacp:inbound:request', handler)
app.bus.off(listenId)

app.bus.listenOnce('nact:peer:disconnect', ({ peerId }) => {})
const { appId } = await app.bus.asyncListenOnce('nacp:internal:napp:success')
```

`app.bus` 是完整的 `EventBus`（见 [eventbus.md](./eventbus.md)）。其他完整事件名见 [nacp.md](./nacp.md)「NACP Event」与 [nact.md](./nact.md)「NACT Event」，NApp 自己只发送下表数据


| key | 触发时机 | payload |
|---|---|---|
| `napp:internal:notify:warning` | 订阅流缓冲区移除，已丢弃最旧的一条 notify | `{ appId, subId, targetSubName, dropped, reason: 'stream-overflow' }` |

<!--AGENT_ATTENTION--
NACP 内部事件名的 level 总是在最后一段（`nacp:internal:gateway:error` 而非 `internal:error:gateway`），这样 `nacp:internal:gateway:*` 能通配关于 Gateway 的一切。按级别捞需要枚举 subject。`napp:` 沿用同一条规则。
-->