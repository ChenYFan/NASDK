# NASDK

Nyirusu Application Software Development Kit，一套**通用的**长时**资源有限**任务调度与应用间通讯框架。

NASDK被设计出来解决这样一类问题：一个任务要跑很长时间、中途要上报内容、可能被取消、还要和别的任务抢同一份资源，同时这些任务可能分散在多个独立进程里，彼此要能互相调用、互相订阅。

NASDK通过区分有过程流的Event事件和简单能力Ability，通过一套**简单的**状态机控制和全局资源占用声明来完成前者任务。同时通过一套JSON-RPC与CBOR二进制编码、允许通过TCP/UnixSocket/WebSocket传输的协议格式来统一后者。

NASDK统一了任务具体执行与通讯过程，不在区分能力上的Client/Server，并**允许Web浏览器**使用同一套标准的交互方式来实现事件处理和通讯。

<details>

<summary>NASDK为什么很适合资源占用型任务调度</summary>

这是一个很现实的问题，本地LLM采样时需要占据几乎所有的GPU资源。对于文本采样时，我们当然可以在启动前给本任务加锁，直到之前的任务完成。

但是当任务变多、变复杂时，这一解决方法变得极其脆弱，你要在每个资源占用任务前给自己加锁，并且加锁类型也会变得复杂。此时你很可能需要一个队列来维持所有资源占用任务，并通过信号告知任务执行时机。

NASDK确实脱胎于Nyirusu Project，一个本地LLM Agentic Runtime。但是设计上，**NASDK 不是 AI SDK。**

它没有 prompt、没有 model、没有 token、没有 tool calling，没有任何 AI 语义。设计上它确实很适合承载 LLM 应用（流式输出、可中断、GPU 独占、多轮工具调用都是它的原生场景）。

但我们认为，这都是**应用层**的事，所以 NASDK 可以脱离 Nyirusu 单独复用。

如果你再考虑NASDK的适合AI的高层包装，可以试试[NAISDK](../NAISDK)！

</details>


## 特性

你可以用NASDK轻易完成下列事件：

- 让一个NApp发送请求到另一个NApp，并且能够监听另一个NApp中本任务的执行过程。
- 把超大二进制直接塞到json里面，然后通过NApp接口发送到另一个NApp。
- 统一前后端格式，能够在浏览器上直接运行NApp，并统一写法。
- 直接将NApp.bus作为EventEmitter，能够在上面发送自定义消息，并且能够直接在另一个NApp上远程订阅。
- 使用NACEB来托管资源占用型任务，比如llama.cpp的textCompletion，并且能在另一个NApp发起请求远程调用。
- 使用NACEB来作为AI应用中的ToolCall部分，能够直接暴露能力与简介，并提供了海量观测事件和Hook用于监听和介入。
- 在一个任务执行期间能够远程终止一个任务的执行，在允许的情况下甚至能够远程重试子任务。
- 一个任务执行期间可以触发构建子任务SubEvent，并且能够选择并发还是阻塞等待结果。
- NACEB被设计为流水线方式，你可以轻松编写对应的PipelineHandler来完成复杂的任务调用。
- NApp完全可以运行在用户网页中，并且可以直接把事件和能力放在用户浏览器上处理。除了不能自行启动Server和必须用WebSocket来连接到另一个NApp，和普通NApp没有差异。

NASDK默认导出五个构件，包括[`NApp`](./docs/napp.md)/[`NACP`](./docs/nacp.md)/[`NACT`](./docs/nact.md)/[`NACEB`](./docs/naceb.md)/[`NACAB`](./docs/nacab.md)。

您很有可能会被这些名字吓住，但是不必担心，他们的语义非常明确：

`NAC`其实是`Nyirusu Application Control`的缩写，表示NApp控制相关。

> Nyirusu 是什么意思请不要在这个仓库里询问！😡

`NACP/NACT`，P表示`Protocol`，表示传输协议。T表示`Transparent`，你也可以理解成`Transport`，表示物理传输方式。

`NACAB/NACEB`，表示AbilityBus和EventBus，是实际上能力与事件请求的处理Processor。

NASDK将所有事件归类为七大族`(un)register/(un)subscribe/notify/request/response`，当NApp接收到对应消息后，会区分`Event`和`Ability`，并将对应请求发送到对应的Processor。

其中，发送Event的请求方还可以直接监听到对应执行方中的过程流，具体调用方法可以参见[`订阅与通知`](./docs/napp.md#订阅与通知)。

### 两种调用，两种处理器

NASDK 把一次远程调用分成两类，区别只有一处，**要不要过程流**。

| | Event | Ability |
|---|---|---|
| 形态 | 多步骤、有生命周期、可暂停可取消 | 一次调用、无状态、瞬时 |
| 回包 | 1 条 response + 0~N 条过程 notify | 1 条 response |
| 资源分配 | 会互相争抢 | 不会 |
| 默认处理器 | NACEB | NACAB |

选哪个由你决定。协议层对两者只有一处实质差异（Event 会自动订阅过程流），其余完全同构。

### 资源调度

NACEB 的通过区分**BlockedTask**和**AsyncTask**，并在前者通过`busyKeys`隔离资源占用来实现调度。

每一次状态转移都可观测（EventBus）、可介入（Hook）、可否决（Veto）。

## 构件一个NApp应用

### 安装

需要 Node.js 20+。

```bash
npm install @chenyfan/nasdk
```

### 开始编写

```ts
import NApp, { NACEB, NACAB } from '@chenyfan/nasdk'
import { TaskHandler, PipelineHandler } from '@chenyfan/nasdk/NACEB'
import { AbilityHandler } from '@chenyfan/nasdk/NACAB'


// ── Task：“如何具体执行一个任务”──
class TranslateCompletion extends TaskHandler {
  name = 'translateCompletion'
  description = '使用LLM模型实现文本翻译'
  busyKeys = ['gpu']
  async execute() {
    let out = ''
    for await (const delta of llm.textCompletionStream(`翻译成中文：\n${this.input}`)) {
      out += delta
      this.processingResultReport({ stage: 'translating', delta })
    }
    return out                                        
  }
}

class SummaryCompletion extends TaskHandler {
  name = 'summaryCompletion'
  description = '使用LLM模型实现文本总结'
  busyKeys = ['gpu']
  async execute() {
    return await llm.textCompletion(`总结以下内容：\n${this.input.join('\n')}`)
  }
}

// ── Pipeline：只决定“下一步跑哪个 task、输入应该是什么”──
class TranslationPipe extends PipelineHandler {
  name = 'Trans'
  description = '翻译流水线，并在翻译结束后完成对所有翻译内容的总结'
  next(lastResult) {
    if (lastResult === undefined) {                    // 首步，从 event 的 payload 取输入
      this.state.done = []
      this.state.todo = [...this.event.payload.paragraphs]
      return { task: 'translateCompletion', input: this.state.todo.shift() }
    }
    if (this.state.summarized) return { task: '$terminal', input: { paragraphs: this.state.done, summary: lastResult } }
    this.state.done.push(lastResult) 
    if (this.state.todo.length) return { task: 'translateCompletion', input: this.state.todo.shift() }
    this.state.summarized = true
    return { task: 'summaryCompletion', input: this.state.done }
  }
}

class Collatz extends AbilityHandler {
  name = 'math.collatz'
  description = '冰雹函数计算'
  async execute() {
    let n = this.input.n, steps = 0
    while (n !== 1) { n = n % 2 ? n * 3 + 1 : n / 2; steps++ }
    return { steps }
  }
}

const naceb = new NACEB({
  pipelineHandlers: [new TranslationPipe()],
  taskHandlers:     [new TranslateCompletion(), new SummaryCompletion()],
  eventAlias: [{ eventName: 'translate', pipelineName: 'Trans', description: '翻译并总结' }],
})
const nacab = new NACAB({ handlers: [new Collatz()] })

const app = new NApp({
  id: 'ai-core',
  server: [
    { type: 'unix', opt: { socketPath: '/tmp/core.sock' } },        
    { type: 'ws',   opt: { ip: '127.0.0.1', port: 8080, path: '/ws' } },
  ],
})

app.bindProcessor('event',   naceb.nacpAdaptor)
app.bindProcessor('ability', nacab.nacpAdaptor)

await app.start()                                     
```

## 调用

你可以额外启动一个NApp，通过unix Socket来与之前的Napp交互。

```ts
const app = new NApp({ id: 'client-app' })
await app.start()
await app.connect('ai-core', { type: 'unix', opt: { socketPath: '/tmp/core.sock' } })


const res = await app.request('ai-core', {
  kind: 'event', 
  target: 'translate', 
  payload: { paragraphs: ['Hello', 'World'] },
  onProcess: (chunk) => process.stdout.write(chunk.delta),   //可以远程监听执行过程中的内容
})
console.log(res.payload.summary)

const { payload } = await app.request('ai-core', { kind: 'ability', target: 'math.collatz', payload: { n: 27 } })
console.log(payload.steps)   // => 111
```

如果对端是存在Web浏览器中的，则只能通过WebSocket来和Server通讯：

```ts
const app = new NApp({ id: 'client-web' })                       // 注意，Web NApp不能填写server，是纯client的。但这并不意味着Web NApp不能有能力和事件处理，你完全可以让Web NApp提供能力，让服务器来调用。
await app.start()
await app.connect('ai-core', { type: 'ws', opt: { ip: '127.0.0.1', port: 8080, path: '/ws' } })
//调用方式没有区别
const res = await app.request('ai-core', {
  kind: 'event', 
  target: 'translate', 
  payload: { paragraphs: ['Hello', 'World'] },
  onProcess: (chunk) => { document.querySelector('#out').textContent += chunk.delta },
})
```

## 文档

- [NApp](./docs/napp.md)  —— NASDK Facade，讲述了装配、生命周期和NApp完整 API
- [NACP](./docs/nacp.md) —— NASDK 通讯协议，讲述了具体消息格式、配对语义、路由与 Gateway
- [NACT](./docs/nact.md) —— NASDK 物理通讯承载协议，讲述分片格式、心跳和网络通讯。浏览器可用，但只能作 ws 客户端、不能建 server。
- [NACEB](./docs/naceb.md) —— NASDK 默认有状态的事件处理机，讲述资源竞争、Hook字段、Veto 与 SubEvent。
- [NACAB](./docs/nacab.md) —— NASDK 默认无状态的能力处理机，讲述具体字段和实现。
- [EventBus](./docs/eventbus.md) —— NASDK 自带的事件总线，提供本地通配符订阅与异步订阅。

## License

MIT License