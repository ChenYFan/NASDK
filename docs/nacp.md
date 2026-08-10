<!--AGENT_ATTENTION--
本文档内有一部分内容为了减少人类阅读负担，是仅AI可见的。
如果你是Agent，请非常严格地遵循注释为--AGENT_ATTENTION--的部分！
-->

# NACP

NACP 全称 Nyirusu Application Control **Protocol**，是NApp通讯协议层，负责规范NACPMessage的RPC-style格式。

在 Nyirusu Project 中，所有具有独立生命周期的应用（Core、Mem、Gateway，以及经 Gateway 接入的 QQ、Bash、OAIBridge、前端 Web）都被称为 Nyirusu Application，简称NApp。NApp之间的通讯均约定使用NACP。

NACP 与 [NApp](../../../NyirusuDoc/napp-pre.md)、[NACT](./nact.md) 三者平行，同属 NASDK 直属成员：下有 NACT 收敛 ws/tcp/unix 收发与编解码，上有 NApp 门面作为用户配置入口。

NACP 与 NACT 之间只用一对 JS API 交互，`nact.host.deliver -> nacp.inbound` 入站、`nacp.outbound -> nact.sendToPeer` 出站。

NACP 内部区分 Event 与 Ability 两种 kind，NASDK 推荐用 [NACEB](./naceb.md) 和 [NACAB](./nacab.md) 分别作为Processor处理。

<!--AGENT_ATTENTION-- 


## 用词规范

- **NACP**，Nyirusu Application Control Protocol，缩写全大写，全小写也可，但不能写成 Nacp。
- **Message**，一条 NACP 包，共 7 个 type，共用 `NACPBaseMessage` 信封。
- **meta**，NACP 自己的协议元数据，每条必带，强类型继承。NACP 只读 meta，不读 payload。
- **appId**，App 的逻辑名，一般文档内写作AppID，字段写作appId。也可用appName称呼，但作为字段统一用 appId，不写 appName。
- **Declaration**，能力声明，注册和调用时用传输自己的 `{events, abilities}`。
- **Processor**，request 入站后处理 Event/Ability 的外部处理器。NASDK中携带了NACEB、NACAB作为推荐的处理器。不应该被称为引擎。
- **AutoSub**，Auto-Subscribe，自动订阅，request 发起时自动订阅、并在 response 时自动取消订阅本次调用的过程流。
- **Response**，响应。表示NACPMessage中对对应操作的回复，也有可能表示本身这个字段的类型。不应该被理解成ack。
- **消息类型**：NACPMessage具有完整的七个类型`(un)subscribe/(un)register/request/response/notify`，具体语义见下文。
- **NACPMessageAction**，NACP动作，NACP在出站时内部根据七个类型对应构造的七个动作，名字和消息类型一一对应，同时承担send对应消息和响应副作用的功能。此名字仅为叙述抽象，代码中不存在同名类型，实际就是 `register/unregister/request/response/notify/subscribe/unsubscribe` 这七个出站方法。
- **NACPMessageOn**，NACP激活入口，NACP在入站是根据七个类型激活对应的`onSubscribe/onUnsubscribe/...`接口。同样仅为叙述抽象，代码中不存在同名类型，实际就是那七个 `onXxx` 方法。
- **族**，为了方便理解，我们抽象了几个名字：
  - **请求族/响应族**，前者指`(un)subscribe/(un)register/request`这五个一般需要等待`Response`的动作，后者是`response/notify`两个用于返回结果和流式过程消息的动作。
  - **内部族/外部族**，前者指`(un)subscribe/(un)register`这四个动作，因为这四个动作是面向NACP的动作（注册、订阅都是对于NApp/NACP而言的），NACP也看见Payload。后者指`request/notify`以及**回 request 的那条 `response`**，NACP不需要了解具体负载。注意 `response` 跨两族：回内部族四个动作的 `response`，其 payload 是 `XxxResponsePayload`、NACP 可见（例如 register 的 response 里 NACP 要读 `isGateway` 做 Gateway 结算）；只有回 `request` 的 `response` 载荷是 `UnknownPayload`、对 NACP opaque。完整可见性见下文 `ResponsePayloadUnion`。
  - **出站族/入站族**，两者只在NACP内部存在，NACP具有七个完整的动作和这七个动作发生时的激活入口，前者是outbound时具体的NACPMessage，后者是对应的NACPMessage通过inbound进入NACP内部。



## 核心原则

- NACP**专为流式、长耗时任务设计**。消息入站后，NACP 按协议动作和类型生成对应请求，转发并监听处理器，把数据完整返回请求方或转发给监听者。
- NACP内部**没有鉴权**。NACP 乃至整个 NASDK 没有鉴权层、没有用户身份概念，默认连进来的都是可信 App。需要鉴权的场景由具体 App 自己在 payload 里做。
- NACP**和NApp共有 EventBus，但没有 Hook**。外部只能观测、不能介入消息流转，这一点与 NACEB 相反。
- NACP默认对**payload 是 opaque的**。在NACP内部载荷类型是 `unknown`，不会、也不应该解读业务含义。序列化打包由 NACT 完成，具体的载荷读取由对应的处理器完成。
- NACP**会维护连接状态，但不会原路返回**。NACP内部回包只看当前包的 `to` 投递，这样设计是为了让 request 除 response 外还能额外收到 notify。 -->

## NACP实例

```
NACP
│
├─ napp: NApp                                #反向引用，NApp 的 public 面
├─ ref: NACPPrivateRef                       #NApp主动裁剪的 的 private 面
│
├─ PeerAppConnectionTable                    #维护NACT Peer <-> NApp之间的关系
├─ ResponsePendingTable                      #记录哪些Request/(un)Register/(un)Subscribe被挂起，等待NACP的Response
├─ SubscribeTable                            #订阅表。记录其他NApp对本NApp的事件订阅
├─ ListenTable                               #监听表。记录本NApp订阅其他Napp的内容
│
├─ inbound(msg, peer)                        #唯一入站
├─ outbound(msg, opt?)                       #唯一出站
│                                            #NACPMessage出站族，均为public。出站族 -> outbound
├─ register(to)                              
├─ unregister(to)                            
├─ request(to, opt)                          
├─ response(to, opt)                         
├─ notify(to, opt)                           
├─ subscribe(to, targetSubName, targetListener?)   
├─ unsubscribe(to, targetSubId)              
│                                            #NACPMessage入站族，均为private。inbound -> 入站族
├─ onRegister(msg, peer)                     
├─ onUnregister(msg)                         
├─ onRequest(msg)                            
├─ onResponse(msg)                           
├─ onNotify(msg)                             
├─ onSubscribe(msg)                          
└─ onUnsubscribe(msg)                        

```



## 消息信封

所有消息共用一个信封，主字段每条必带：

```jsonc
{
  "v": { "major": 1, "minor": 0 },  // 协议版本
  "t": 1720800000000,               // epoch ms时间戳
  "id": "uuid",                     // 消息 id
  "from": "",                       // 发件 App 名
  "to": "",                         // 收件 App 名
  "type": "register | unregister | subscribe | unsubscribe | notify | request | response",
  "meta": { /* 各 type 自己的 XxxMeta */ },
  "payload?": unknown               // 业务载荷，NACP opaque
}
```

- **版本 `v` 只在 register 握手校验一次**：同 major 兼容，跨 major 拒连。其余消息带而不校验。
- **业务数据与协议数据的分离**：payload 是业务数据，NACP 永远不可见；meta 是协议数据、NACP 读且认为是强类型。

NACP信封本身作为一个基类，7 个 type 各自 `extends`、把 `type` 确定到字面量、把 `meta` 确定到对应 `XxxMeta`，对外是一个 `type` 判别的联合类型：

```ts
type NACPType = 'register' | 'unregister' | 'subscribe' | 'unsubscribe' | 'notify' | 'request' | 'response'

interface NACPBaseMessage {
  v: ProtocolVersion; type: NACPType; id: string
  from: string; to: string; t: number
  payload?: unknown; meta: BaseMeta
}

interface BaseMeta { parentId?: string }   // 配对锚：回指类挂它，发起类不带

interface RegisterMessage extends NACPBaseMessage { type: 'register'; meta: RegisterMeta }
// ... 其余 6 个同构
```

消息本体与 meta 是两棵平行继承树，靠本体的meta类型对齐。

## 消息类型

NACP的消息被分为七类，包含：

| type | 含义 | 期待回包 | 语义对应 |
|---|---|---|---|
| `register` | 连接后第一条握手，通报身份并交换能力声明 | `1 response` | `unregister` |
| `unregister` | 优雅下线 | `1 response` | `register` |
| `request` | 调 Event / Ability | `1 response + 0~N notify` | `response` |
| `response` | 上述发起动作的统一终结信号 | - | `request` |
| `subscribe` | 远程 listen | `1 response` | `notify` & `unsubscribe` |
| `unsubscribe` | 远程 off | `1 response` | `subscribe` |
| `notify` | 订阅命中后的单向推送 | - | `subscribe` |

注意，在NACP的inbound和outbound触发时，都会触发`nacp:inbound/outbound:{type}`事件。

> **期待回包** 和 **语义对应**
>
> 期待回包表示发送方发出请求后期望获得的响应。例如，发出register或subscribe之后发送方都希望接收方返回一条response，以明确上次的操作是不是有效的。
>
> 其中request根据kind的差异，期待回包可能会携带多条notify。
>
> 语义对应和期待回包不完全一致。语义对应指的是本次操作的`相对操作`，例如注册register的相对操作是注销unregitser，订阅subscribe的相对操作是取消订阅unsubscribe或通知notify。语义对应更多的是便于开发者和用户理解，具体回包差异参考`期待回包`

### register

连接建立后的第一条消息，双向对称交换身份与能力声明。

发送方期望获得一个`Response`，表示链接认可。

#### sendRegister

```ts
interface RegisterMeta extends BaseMeta {}
interface RegisterPayload extends BasePayload {
  isGateway: boolean; 
  decl: Declaration; 
  record?: boolean
}
```

其中`decl`字段可以在随后的`Request - Introduce`中通过内建`NApp.introduce`的Ability再次获取。

期望获得`RegisterResponsePayload`，同样

#### onRegister

> 在inbound触发onRegister之前，NACP还会检查register消息中to对象是否是自己。无论自己是不是Gateway，如果注册对象不是自己，NACP都会选择丢弃该包并警告。

当接受到onRegister消息后，NACP内部会执行以下内容

1. 如果自己和对方都是Gateway，则拒绝（dual-gateway）
2. 版本major不匹配，拒绝（version-mismatch）
3. 内部已存在对应AppID，拒绝（appId-in-use）
4. 绑定PeerID与AppID。在这之前的错误信息均绕过appid直发peerid，在这之后不再允许这么做，必须通过appid索引查找。
4. 如果对方是Gateway并且自己正好没有Gateway，则将对方设为自己的Gateway。否则根据`autoMultiGatewayDowngrade`决定降级为普通节点还是进入断连。
5. emit `nacp:internal:napp:success` 事件，`reason: 'bound'`
6. 准备自己的Response包，告知自己的能力和是否为Gateway，并返回包。

### unregister

告知对方本节点已准备下线，期望断开并清理所有联系，并希望获得一个Response。

也被称为`优雅下线`、`链接凋零`，和直接断开NACT层的下线方式相对。

#### sendUnregister

```ts
interface UnregisterMeta extends BaseMeta {}   // 刻意为空
```

发出后等一个 response 确认对端已清理完毕，收到后自己再断连。

#### onUnregister

顺序是**先回包、再清理**：

1. 根据AppID出站 `response{isOk:true}` 消息
2. 清空本appid在NACP内部表中的数据，并逐个撤掉替它挂的所有 listener。
3. 广播`nacp:internal:napp:success`事件，`reason: 'dropped'`。

如果NACT层强制断连，则没有机会发 unregister。

此时 NACP 自己监听 `nact:peer:disconnect`，反查 appId 走同一套清理机制（注意不是发虚拟包）。

unregister 是优化项不是必需项，协议其实并不绝对依赖它，它只让下线变得干净可预期。


### request

request 包含两个 kind：Event 事件和 Ability 能力。

发送方期望获得一个 `Response` 作为终结信号。其中 Event 还可能额外收到 0~N 条 `Notify` 作为过程流。

request 会AutoSub自动订阅Event的对应过程流。

#### sendRequest

```ts
interface RequestMeta extends BaseMeta {
  kind: 'event' | 'ability'
  target?: string   // 能力/事件全名，如 'qq.send'
}
```

| kind | 状态 | notify | 处理者 |
|---|---|---|---|
| `event` | 事件触发的任务有持久状态、有生命周期、可能需要多阶段、需要过程流 | 0~N | 需要外部绑定的Event Processor，推荐 NACEB |
| `ability` | 无状态、瞬时 | 0 | 需要外部绑定的Ability Processor，推荐 NACAB |

`event`和`ability`的区分主要由开发者自己决定。NACP 对两者只有一处实质差异，只有 `event` 会进行AutoSub，自动订阅过程流。

> AutoSub，即Auto-Subscribe机制，指NACP在发现EventRequest出站的时候，自动订阅相关`Progress`流、并在知晓对应`Response`取消订阅。
>
> AutoSub的原理和机制**完全等同**默认的`subscribe`/`unsubscribe`：在req时自动订阅，在res时取消订阅。差异只有三点：
>
> 1. 包没有真的发出去。发送方不发`Subscribe`和`Unsubscribe`，接收方也不对这两个虚拟包回`Response`。因此，你无法从NApp的EventBus上监听AutoSub相关消息。
> 2. Sub会在req真正开始执行前就挂上。以避免手动Subscribe因网络因素导致监听器挂载不及时、漏掉前几个chunk的情况。
> 3. 虚拟`Subscribe`的`SubId`就是`RequestId`，虚拟`Unsubscribe`的`TargetSubId`同样是`RequestId`。
>
> 简而言之，`AutoSub`机制主要是减少NApp外部交互次数、减少NApp通讯交互的的双方约定俗成的行为。


两种 kind 的完整回包字段：

```
ability : request{kind:'ability', target}   → response{kind:'ability', isOk, parentId}
event   : request{kind:'event', target}     → notify{parentId=reqId, hitSubName} × 0..N   #过程流
                                            → response{kind:'event', isOk, parentId}      #结束包
```



#### onRequest

1. 按 kind 取出绑定的 Event/Ability Processor。
2. 如果是Event，则直接调用 `onSubscribe(...,{autoSub:true})`（即虚拟一条Subscribe入站，但是标记为不发送Response）
3. 把请求推进处理器，同时交出 `onProcess` / `onResponse` 两个回调。

两个`on`回调都是先广播消息到 bus、再翻译成消息出站：

- `onProcess(chunk)` → 会广播`nacp:{kind}:{reqId}:process`，并命中第二步的 listener，最后打包 notify 出站。
- `onResponse(result, isOk, whyNotOk)` → 会广播`nacp:{kind}:{reqId}:response`，并发包发送 `response`。AutoSub的撤订随这条`response`的出站发生（在`response()`里虚拟一条`unsubscribe`入站），不在这个回调里做。

request永远期待1条Response，即使是有错误。

> 如果绕开直接调用 `nacp.inbound()` 则有可能触发一条错误的kind Request，此时会返回对应的没有processor报错。

<!--AGENT_ATTENTION-- 

```ts
interface Processor {                                 // 两 kind 通用
  list(): { name: string; description: string }[]     // 供 register 的 Declaration
  push(
    spec: { target: string; payload: unknown; reqId: string },
    hooks: {
      onResponse: (result: unknown, isOk: boolean, whyNotOk?: string) => void,  // 终局；whyNotOk 只给协议级说法
      onProcess:  (chunk: unknown) => void,                                     // 过程，ability 从不调
    },
  ): string | void   // 可返回处理器内部 id；NACP 不接
}

interface AbilityProcessor extends Processor {         // 仅 ability 侧
  register(item: { name, description, execute(payload) }): void
}
```

契约放 NASDK 根共享 types，NACEB / NACAB 各暴露 `nacpAdaptor` 满足它。

**`register` 只在 ability 侧**。它是一个平凡的能力注册口，和用户添加能力用的是同一个。event 侧没有它：一个 event 的实现体不是单个可调用物，NACEB 要把 event 名解析成一条 pipeline，`register(item)` 在那边没有能指。

**回调走 emit 而非点对点 notify**，这层间接是 subscribe 能统一的原因：一次调用的过程与终结**本身就是 bus 事件**，订阅它们不需要任何特例，Processor 和 NACP 都不必知道谁在看。

**两层 id 隔离**：NACP 只认 `reqId`，即 request 的消息 id，当 opaque 句柄传给 `push`；Processor 内部的 eventId 等实现 id 不泄漏进 NACP。

#### App 自己的能力

查询对端内部信息——能力声明、将来的统计/连接快照等——**不新增 kind、不新增消息类型、也不新增任何机制**，就是一条普通的 `kind:'ability'` 调用：

| 名字 | 作用 | 返回 |
|---|---|---|
| `NApp.introduce` | 要对端完整能力声明。register 已给过一份，想**刷新**才用 | response payload 里的 `Declaration` |

**命名约定：App 自建的能力一律以 `NApp.` 开头**，将来的 `NApp.stat` / `NApp.peers` 同理。这只是命名空间，不是保留字——见下。

**NACP 完全不参与**。它不造这些能力、不注入、也不知道有这回事——`onRequest` 里没有任何特例分支。是 **NApp 在装配时通过 `AbilityProcessor.register` 把自己的能力注册进去**，走的和用户注册能力完全同一条路径。详见 [napp-pre.md](../../../NyirusuDoc/napp-pre.md)。

对处理器而言，这就是一次普通注册：

- **没有特权层、没有保留字、没有旁路**。`NApp.` 只是命名空间，不做任何检查也不做任何保护。注册是后写入者胜，和普通 map 一致——这些是 App 提供的便利，不是需要防卫的协议保证。覆盖时机见 [napp-pre.md](../../../NyirusuDoc/napp-pre.md)。
- **处理器只有一张表**。App 注册的和用户注册的落在同一张表、走同一条查找，处理器分辨不出来，也没有「内建」这个概念。
- **自动进声明**：它在 `list()` 输出里，因此对端 register 一次就知道有哪些可查，无需额外发现机制。
- **结果落 payload**：它是 ability 的返回值，走 `onResponse` → response payload。回 register 的那条 response 也把 `decl` 放在 payload（`RegisterResponsePayload`）—— 同一个 `buildDecl()` 数据源，两个消费场景都走 payload，不再有「一个走 meta 一个走 payload」的不对称。

事件侧没有对应物：event 的实现体不是单个闭包，`register` 也就不在 event 契约里。 -->




### response

(un)register / (un)subscribe / request 的期望信号、结果信号和结束信号，通过`parentId`字段与被回消息对应。

response包的出现代表着上一次NACPMessage包引发的事件结束，是作为最终消息存在的。

> 过程消息请使用notify。

一条 response 具有确定性、唯一性和终结性。

- **确定性**：一定由信封 `to` 指向的那个 App 返回。**Gateway 不能代答**，只能转发。
- **唯一性**：一个操作有、必须有、且只有一条。response 与 notify 自己除外，这俩本身就是回包类，不需要接受者额外回包。
- **终结性**：本次NACPMessage引发的操作正式结束。即使失败也是通过Response告知，在meta的isOk中标记结果。

> 这个行为**不叫 ack**。类比 TCP 的 ack 可以由中间节点捎带、可以聚合、可以延迟，收到之后连接继续——恰好与确定性、唯一性、终结性三条全部冲突。**Response / Res 既指 `response` 这个 NACPMessageType，也指请求发出后期望的那个回复包**。请不要用ack理解response模型！

在发送Response时，如果Response对应的是Request并且是Event Kind，则会额外触发一次`onUnsubscribe`虚拟入站，意义是`事件已结束，自动取消订阅`。

#### sendResponse

```ts
interface ResponseMeta extends BaseMeta {
  parentId: string     // 被回消息的 id，必填
  isOk: boolean        
  whyNotOk?: string    // isOk=false 时的原因
  kind?: RequestKind   // 仅回 request 时带
}

interface ResponsePayload             extends BasePayload {}      // response 族的根，自己也是一个 XxxPayload
interface RegisterResponsePayload    extends ResponsePayload, RegisterPayload {}   // 同构：register 是对称交换
interface UnregisterResponsePayload  extends ResponsePayload {}
interface SubscribeResponsePayload   extends ResponsePayload {}
interface UnsubscribeResponsePayload extends ResponsePayload {}

type ResponsePayloadUnion =
  | RegisterResponsePayload | UnregisterResponsePayload
  | SubscribeResponsePayload | UnsubscribeResponsePayload
  | UnknownPayload 
```

Processor的具体错误请在payload中表示。Adaptor 只报告自己那一层的事实，不解读下层处理器出了什么错。对端先读 `whyNotOk` 做决策，要细节再去 payload 获取。

`kind` 只在回 request 时带，是 meta 里唯一的条件字段。


```ts
interface RegisterPayload    { isGateway: boolean; decl: Declaration; record?: boolean }
interface UnregisterPayload  {}
interface SubscribePayload   { targetSubName: string }
interface UnsubscribePayload { targetSubId: string }

interface RegisterResponsePayload    extends RegisterPayload {}   // 同构，不重抄字段
interface UnregisterResponsePayload  {}
interface SubscribeResponsePayload   {}
interface UnsubscribeResponsePayload {}
```

payload 只有一个根 `BasePayload`，**每个 `XxxPayload` 都直接继承它**——包括 `ResponsePayload` 自己。

```
BasePayload
├─ RegisterPayload / UnregisterPayload / SubscribePayload / UnsubscribePayload  
├─ UnknownPayload                                                               
└─ ResponsePayload                                                              
   └─ RegisterResponsePayload / UnregisterResponsePayload /
      SubscribeResponsePayload / UnsubscribeResponsePayload
```

`UnknownPayload` 是发起族的**兄弟而不是子节点**：如果它继承了发起族里任何一个，那么一个接受「NACP 可见族」的函数就会静默地也接受 notify 的 payload——正好丢掉这套层级唯一想表达的区分。

其中 `RegisterResponsePayload` 直接双继承 `ResponsePayload, RegisterPayload`。因为RegisterResponse的本质就是在提供同样的消息给对方。


#### onResponse

NACP在接收到Response信号时，会认为对应的操作已结束，并执行以下操作：

1. 如果这条`response`的`meta.kind`是`event`，则会虚拟一条`unsubscribe`出站消息，取消自己的订阅。
2. 从`ResponsePendingTable` 表中取出Waiter并清掉超时定时器。如果取不到 waiter，则只 emit `error:response`，reason 为 `has-no-consumer`，**不回包**。
3. 按 `isOk` 决定 resolve 还是 reject。

`response` 是 (un)register / (un)subscribe / request 五种发起操作的**统一终结信号**，所以 `onResponse` 是 NACP 所有操作的统一返回口。

但 `onResponse` 自己对这五种**没有任何分支**，只通过 `parentId` 去 `ResponsePendingTable` 里找 Waiter，找到就 resolve/reject。

差异只在**各自出站族的 await 处**，出站族如果需要等待结果应该用`send4Response`来发送比等待结果。

此外，部分内部族的Payload是可见的，具体的可见类以`ResponsePayloadUnion`为准。

##### ResponsePayloadUnion

`meta` 一律是 `ResponseMeta`，但 `payload` 按这份载荷是给哪个NACPMessage的分类。`ResponseMessage.payload` 的类型就是下表五种的联合——注意 `ResponsePayload` 是 response 族的**基类**（四个 `XxxResponsePayload` 继承它），而 `UnknownPayload` 不在这一族里，它是 `BasePayload` 的直接子节点，所以「response 的 payload」这个集合跨了两处，得靠联合类型表达：

| 被回的操作 | payload 类型 | NACP 是否可见 | 内容 |
|---|---|---|---|
| `register` | `RegisterResponsePayload` | T | 同 `RegisterPayload = { isGateway, decl, record? }` |
| `unregister` | `UnregisterResponsePayload` | T | `{}` |
| `subscribe` | `SubscribeResponsePayload` | T | `{}` |
| `unsubscribe` | `UnsubscribeResponsePayload` | T | `{}` |
| `request` | `UnknownPayload` | F | 业务结果，opaque |

<!--AGENT_ATTENTION-- 

##### resolve / reject

| 操作 | 由谁消费 | 做什么 |
|---|---|---|
| `register` | `NACP.register()` | 校验 `res.from` 是否为期望的 appId（不符则 `expect-mismatch`）；读 payload 的 `isGateway` 走 `settleGatewayByDeclared` 结算 Gateway 槽位；结果为 `conflict` 则发 `unregister` 并以 `multi-gateway` 失败；成功 emit `nacp:internal:napp:success`（`reason: 'bound'`） |
| `unregister` | `NApp.terminate()` | 确认对端已清理完毕。用 `allSettled` 收集，失败不阻塞下线 |
| `subscribe` | `NApp.subscribe()` | 取 `meta.parentId` 作为 `subId` 返给调用方，用于日后 unsubscribe。该值就是那条 subscribe 消息自己的 id，由被订方在 `onSubscribe` 里原样回写进 `parentId` |
| `unsubscribe` | 调用方 | 确认远端已 `off` |
| `request` | 调用方 await | 拿 `payload` 作为业务结果。Event 的过程流在此之前已经经 notify 交付完毕 |

注意 `register` 这一行的消费者是 **`NACP.register()` 自己，不是 `NApp.connect()`**。`NApp.connect()` 是一层薄门面，只做「拨号 → 调 `nacp.register` → 返回 false 就抛 `nappOutbound('register-failed')`」，它没有 catch 块，不校验、不读 payload、不回滚、不关连接。上表其余四行才真的在 NApp 门面侧消费。

`register` 的 reject 路径尤其重要，但两类拒绝的来源不同，不要混为一谈：

- **对端协议拒绝**：`dual-gateway` / `version-mismatch` / `appId-in-use`，以及被连方结算出 `conflict` 时的 `multi-gateway`。这些由对端回 `isOk:false` + `whyNotOk`。
- **本地校验失败**：`expect-mismatch`（`res.from` 与期望 appId 不符），以及拨号方本地 `settleGatewayByDeclared` 结算出 `conflict` 时的 `multi-gateway`。此时**对端回的是 `isOk:true`**，失败是本地判定的结果，与 `whyNotOk` 无关。

所以 `multi-gateway` 横跨两类：被连方拒绝时走 `isOk:false`，拨号方本地结算冲突时不走。

两类拒绝最终都汇到 `NACP.register()` 内部的 `fail()` 闭包，由它统一 emit `nacp:internal:register:error`、`dropAppId(to)` 回滚绑定、`peer.close()` 关连接，并返回 `false`。回滚用的是 `dropAppId` 而不是「回滚 `bindAppId`」。

> `request` 的超时是 `-1`（永不超时）——业务调用耗时框架无从预估。其余四种是 10s：它们是协议握手，必须快。两个值都是模块顶层硬编码常量，不可配置。 -->


### subscribe

订阅一个远程NApp的EventBus事件。

> 可以理解为在App1中直接listen App2的EventBus，注意NACP和NACT没有自己的EventBus，实际监听对象是对方NApp的整个EventBus。

发送方期望获得一个 `Response` 确认订阅建立，之后是 0~N 条 `Notify`。

#### sendSubscribe

```ts
interface SubscribeMeta extends BaseMeta {}                       // 空
interface SubscribePayload { targetSubName: string }              // 要订的 event name，可带多段 *
```

`targetSubName` 直接是被订方 EventBus 上的一个事件名，可以有多段`*`，例如`*:error:*`

subId 就是 subscribe 消息的 id，同时是后续 notify 的 `parentId`、以及 unsubscribe 要给的 `targetSubId`。

#### onSubscribe

1. 在本 App 的 bus 上挂一个转发 listener，每次命中就打包成 notify 发给订阅者。
2. 把 `{subId, appId, listenId, targetSubName}` 记进 `SubscribeTable`。
3. 如果不是`autoSub`，则出站返回 `response{isOk:true}`。否则不发Response包。

`SubscribeTable` 是 listenId 归属记录，唯一的用途是在断连时按 appId 把该 App 挂的所有 listener 一起 off。

如果一条 emit 被多个 subscribe 命中，则每个 subId 各发一条 notify。

### unsubscribe

取消订阅一个远程NApp的EventBus事件。即撤销对应的 subscribe 请求。

发送方期望获得一个 `Response`。

#### sendUnsubscribe

```ts
interface UnsubscribeMeta extends BaseMeta {}                     // 空
interface UnsubscribePayload { targetSubId: string }              // 要退订的那条 subscribe 的 id
```

`targetSubId` 是那条 subscribe 消息的 id，即 subId，不是 listenId。

> listenId 是被订方的本地实现和监听器细节，不会出站。

出站前会删掉本地 `ListenTable` 里 `targetSubId` 那条记录。

#### onUnsubscribe

1. 反查 `SubscribeTable` 拿到记录。查不到则 emit `error:subscribe`，reason 为 `unknown-subscription`。
2. `off(rec.listenId)` 撤掉 listener，从表移除。
3. 如果不是autoSub，则准备回包。否则不回。
4. 如果第一步成功，回包 `response{isOk:true}`，否则`response{isOk:false, whyNotOk:'unknown-subscription'}`。

### notify

NApp内部发生的事件被远程订阅，需要将具体的事件发给订阅方。

一个Subscribe事件可以接收到多条Notify，一条Notify也可能命中多个监听者。

#### sendNotify

```ts
interface NotifyMeta extends BaseMeta {
  parentId: string        // 显式订阅默认是subId，如果是AutoSub这里是reqId
  targetSubName: string   // 源订阅 event name，可能带 * 通配
  hitSubName: string      // 实际命中的具体 event name，无通配
}
```

payload 是被订方那次 emit 的 payload，纯透传。

本事件一般由转发 listener 命中后自动打包，设计上不应该被手动发送。

#### onNotify

在`ListenTable`查阅`parentId`，并将整个内容交给该记录的 `targetListener`。

如果命中的`targetListener`少于一个，则额外 emit `error:notify`，reason 为 `has-no-consumer`。

这条错误记录不会发送给被订阅方，即不报错给对端。

## 出入站

NACP 只有两个物理面：`inbound` 入站、`outbound` 出站，各自先 emit 自己的事件再实现副作用。

```
出站：app.request(to, {kind, target, payload})   NApp 门面，转交 NACP
        → NACP.request(...)                      造包 + 副作用 + outbound
        → NACP.outbound(msg, opt?)               查表得 toPeerId → emit → nact.sendToPeer
        → NACT 分片 + CBOR 编码 + 上线

入站：NACT 收字节 → CBOR 解码 → NACPMessage
        → NACP.inbound(msg, peer)                emit → 读 to 丢/转/收 → 读 type/meta → 副作用
```

`buildMessage(self, type, to, opt)` 是造包唯一入口，内部 `switch(type)` 组装 meta 并签写NACPMessage通用字段。




### 内部状态

```
NACP
├── peerAppTable:   PeerAppConnectionTable   appIdPeerSheet:      appId → peerId
├── pendingTable:   ResponsePendingTable     msgIdPendingSheet:   msgId → PendingEntry
├── subscribeTable: SubscribeTable           subIdSubscribeSheet: subId → SubRecord
└── listenTable:    ListenTable              subIdListenSheet:    subId → ListenRecord
```

| 表 | 内容 | 写入时机 | 清理时机 |
|---|---|---|---|
| `peerAppTable` | NACT PeerID与NApp名字的对应表 | onRegister 校验通过后 | unregister / 断连 |
| `pendingTable` | 等待Response的回包的 waiter| 出站等待类消息时 | 收到 response 时结算，或超时、断连批量 fail |
| `subscribeTable` | 替对端在本 App bus 上挂的 listener | onSubscribe，以及 event request 的 AutoSub | onUnsubscribe / 断连 |
| `listenTable` | 自己订阅对端时登记的本地回调 | `subscribe()` 出站时 | `unsubscribe()` / 断连 |

`subscribeTable` 与 `listenTable` 是一条订阅的两半，键均为 `subId`。

| 表 | 在哪一侧 | 语义 | 管什么方向 |
|---|---|---|---|
| `subscribeTable` | 被订方 | 谁订了我 bus 上的什么 | 事件发生 → **notify 出站** |
| `listenTable` | 订阅方 | 我订了什么、该交给谁处理事件 | **notify 入站** → 激活监听器 |






## Gateway

Gateway 是 NApp 的一个性质，`new NApp` 时声明，运行期不可变。

Gateway只关注收到 `to` 不是自己的包。普通的NApp会丢弃，但是Gateway会代为出站，内容保持不动。

因此 Gateway 被设计为无状态，不需要任何 `request→peer` 映射表。「回给谁」由以下三条逻辑保持为无状态：

- **`from`/`to` 端到端**，任何中转都不改写。真正的收件人永远在 `from` 里。
- **发回包时交换 from↔to**，真正的收件人如果要返回response，只需要交换from/to。
- **所有节点只看当前包的 `to` 投递**。回包的 to 恰好指向发起方，普通投递就送回去了。不存在原路返回。

> 因此，NACP是允许逻辑收包、逻辑发包、物理收包、物理发包都不是一个节点。但如果在消息传递期间发生路由变动则可能出现消息序列错乱，具体在注意事项中观测。

### 入站转发

转发是 App 的入站行为，是机械逻辑：

```
1. 入站包to是否等于self，如果是直接跳到第4步，否则进入第二步
2. type 是 register 则直接丢弃，register 永不参与转发
3. 本节点 isGateway 为false则丢弃。如果为true，还要检查自己PeerAppConnectionTable有没有to的NApp，如果有，转发出站，并跳过第四步，没有则丢弃。
4. 入站包
```

- Gateway 是唯一中心交换机，任意 App 到 Gateway 都是 1 跳，故永远认识 to、永不误丢。
- 叶子节点零转发，非Gateway节点收到不属于自己的包直接丢弃
- 允许叶子节点相互直连，禁止的只是叶子替叶子转发。

### 出站路由

出站先 emit `nacp:outbound:{type}`，再决定投递。同样是机械逻辑：

```
1. to 如果是自己，则立刻终止，不出站。广播错误，emit error:route，reason 为 self-addressed。
2. 如果PeerAppConnectionTable表有对应to节点的链接，则立刻出站。否则进入第三步
3. 如果本节点有连接到Gateway，则出站给Gateway。否则进入第四步
4. 广播错误，emit error:route，reason 为 no-route
```


### Dual-Gateway

谁声明了 `isGateway:true`，连上它的NApp就都把它当Gateway。

Gateway的本质是兜底路由，如果路由表内没有目标节点，已连接上Gateway的叶子节点都会直接转发包丢给Gateway。

因此一个NApp只能连接到一个Gateway，第二个声明 Gateway 的对端不会直接覆盖它。

如果NApp创建时`autoMultiGatewayDowngrade:true`则会将另一个Gateway降级为普通连接，否则触发 unregister 凋零。

两个 `isGateway:true` 互连时，被连方以 `dual-gateway` 拒连。




## NACP API

NACP公开了一部分API，一般用于NApp和NACT直接调用。

NACP自己也是直接公开在`Napp.nacp`中，可以直接用此处绕过NApp门面通讯（但不建议）。

NACP默认公开所有出站族，但不允许虚拟入站族。如果需要入站，应该用inbound入口。

### 直接出入站方法

| 方法 | 说明 |
|---|---|
| `inbound(msg, peer)` | 入站统一入口，一般由 NACT 经 ref box 调 |
| `outbound(msg, opt?)` | 出站统一入口，返回 `boolean` 表示是否交给了 NACT，`opt: {peerId?, forwarded?}` |

> **注意**
>
> 两者都是公开的，但一般不建议通过这种方式发送**出站信息**，因为会丢失状态、等待和副作用。建议仅用于调试作用。
>
> 正常出站请使用一下出站族。


### 出站方法族

| 方法 | 返回 |
|---|---|
| `register(to)` | `Promise<ResponseMessage>` |
| `unregister(to)` | `Promise<ResponseMessage>` |
| `request(to, opt)` | `Promise<ResponseMessage>` |
| `subscribe(to, targetSubName, targetListener?, opt?)` | `Promise<ResponseMessage> \| void` |
| `unsubscribe(to, targetSubId, opt?)` | `Promise<ResponseMessage> \| void` |
| `response(to, opt)` | `boolean` |
| `notify(to, opt)` | `boolean` |

前五个请求族期待回包，需要等待对应的Response回包后才会resolve/reject。

AutoSub不会激活对应的Response，因此没有`Promise<ResponseMessage>`返回。此时返回的是void。

`response` / `notify` 是响应族、不期待回包，所以它们返回的不是 Promise 而是一个 `boolean`：`true` 表示消息已交给 NACT，`false` 表示没能出站（self-addressed / no-route / send-failed 三种，具体原因发在 `nacp:internal:route:error`）。这是响应族唯一的成败信号——它们没有回包能在事后揭示失败。

> `response` 即使没能出站，AutoSub 的撤订也照样执行。被撤的那半边 SubscribeTable 记录是本端的，不能因为对端已经断了就留在表里。



### 其它API

| 方法 | 说明 |
|---|---|
| `bindAppId(appId, peerId)` | 绑定 appId 与 peer |
| `checkAppId(appId)` | 是否已连接该 App |
| `dropAppId(appId)` | 解绑，握手失败回滚用 |
| `listAppId()` | 全部已连 appId |
| `getAppPeerId(appId)` | 该 App 走哪条 peer |
| `settleGatewayByDeclared(appId, peerId, declared)` | 按对端声明结算Gateway槽位，返回 `adopted`/`downgraded`/`conflict`/`not-declared`。 |
| `getGatewayPeerId()` | 当前作为Gateway的是哪条 peer |
| `getSubCount()` | 本NACP的订阅数，即 SubscribeTable |
| `getListenCount()` | 本NACP持有的订阅数，即 ListenTable |
| `getPendingCount()` | 本NACP在等待回包数数，即 ResponsePendingTable |
| `terminate()` | fail 所有 Waiter、off 所有 listener、清所有表 |


## NACP Event

NACP 不持有 bus。NACP 和 NACT 都是监听和挂在在`NApp.EventBus`上的。

NACP 触发的事件以`nacp:`开头，主要分为下面的方式

| key 模式 | 含义 | payload |
|---|---|---|
| `nacp:{inbound\|outbound}:{type}` | 一条消息从 NACP 入站/出站 | `{ fromPeerId \| toPeerId?, msg<NACPMessage> }` |
| `nacp:{event\|ability}:{reqId}:{process\|response}` | 一次Request的具体执行过程消息/结束消息 | 原始 chunk / `{ result, isOk, whyNotOk }` |
| `nacp:internal:{layer}:{level}` | 内部事件 | 见下，一律带 `reason` |

### 出入站事件

`nacp:inbound:{type}` 与 `nacp:outbound:{type}`，7 个 type 各一个。

当对应的`inbound`和`outbound`被激活的时候，第一步就是触发本消息，无论本消息是否真的已经发送出去。

需要注意的是，如果是Gateway转发消息，会同时触发`nacp:outbound:{type}`和`nacp:internal:route:forwarded`。前者表示出站消息，后者表示本消息转发来源和目的地。

### 请求过程与结果事件

| key | 触发时机 | payload |
|---|---|---|
| `nacp:event:{reqId}:process` | Processor 每产出一个 chunk | 原始 chunk |
| `nacp:event:{reqId}:response` | event 返回结果 | `{ result, isOk, whyNotOk }` |
| `nacp:ability:{reqId}:response` | ability 返回结果 | `{ result, isOk, whyNotOk }` |

emit 调用族事件时会传一个 `thisArg`，内容是 `{ hitSubName }`，即本次实际命中的具体名字。通过通配订阅的监听者可以通过`hitSubName`读取实际命中的消息。

### 内部族

级别取 `error` / `warning` / `log` / `success`。

payload 一律带 `reason`。

| key | 触发时机 | reason | payload |
|---|---|---|---|
| `nacp:internal:napp:success` | appId与peer 绑定发生变动 | `bound` / `dropped` | `{ appId, reason, isGateway? }` |
| `nacp:internal:gateway:success` | Gateway 代发了一条包 | `forwarded` | `{ toPeerId, msg, reason }` |
| `nacp:internal:gateway:error` | Gateway 找不到转发的目标 | `dropped` | `{ msg, reason }` |
| `nacp:internal:gateway:warning` | 第二个声明 Gateway 的对端被降级 | `multi-gateway-downgraded` | `{ appId, peerId, keptGatewayPeerId, reason }` |
| `nacp:internal:register:error` | register 握手失败 | `dual-gateway` / `version-mismatch` / `appId-in-use` / `multi-gateway` / `expect-mismatch` / `response-timeout` | `{ fromPeerId, from, reason }` |
| `nacp:internal:request:error` | request 无法受理 | `no-processor` | `{ msg, reason }` |
| `nacp:internal:response:error` | response 找不到 Waiter | `has-no-consumer` | `{ msg, reason }` |
| `nacp:internal:route:error` | 出站（非Gateway转发）无路可走 | `no-route` / `send-failed` / `self-addressed` | `{ msg, reason }` |
| `nacp:internal:notify:error` | notify 找不到订阅 | `has-no-consumer` | `{ msg, reason }` |
| `nacp:internal:subscribe:error` | unsubscribe 找不到那条订阅 | `unknown-subscription` | `{ msg, reason }` |
