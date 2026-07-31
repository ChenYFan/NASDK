<style>
.hooks { border-collapse: collapse; width: 100%; font-size: 14px; }
.hooks th { background: #2d2d2d; color: #e0e0e0; padding: 6px 10px; text-align: left; }
.hooks td { padding: 5px 10px; border-bottom: 1px solid #444; vertical-align: top; }
.hooks .bf { color: #f0a060; font-weight: bold; }
.hooks .af { color: #60b0f0; font-weight: bold; }
.hooks .st { color: #c0c0c0; background: #1e1e1e; text-align: center; width: 80px; }
</style>

[$] NACAB是新的抽象层。
[$] 注意从NyirusuProject第二次重构开始，使用TypeScript开始编写Share库

# NACAB

NACAB全称 Nyirusu Application Control Ability Bus，是被设计为**Request-Response**能力执行器。

NACAB 与 NACEB 平行，NACEB 处理多步骤、有资源竞争、带 Hook/Veto 的 Event；NACAB 处理单次调用、无状态、纯回结果的 Ability。

NACAB 没有 Pipeline、没有 Controller、没有 tick、没有 Hook、没有 Veto、没有 pause、没有 busyKey，也没有过程中上报。

NACAB只忠诚一件事情，注册函数，执行函数。他的本质和一个new Map没有区别，只是加入了和NACEB一样的可观测和保存结果机制。

## 用词规范

- **NACAB**，Nyirusu Application Control Ability Bus，缩写必须全部大写，不能写成 Nacab、nacab 等。
- **Ability**，指一个可调用的能力。对应一个 AbilityHandler。声明项 `Ability` 只有 name 和 description。
- **AbilityHandler**，无状态的执行逻辑。注册一次、全局复用。`execute()` 的 `this` 绑定为 AbilityInstance，通过 `this.input` 拿输入。
- **AbilityInstance**，每次 invoke 的运行时记录。持有 id、input、status、result/error。invoke 内部同步跑完 pending→running→done/failure，外部通过 `getTask(id)` 查记录。
- **AbilityStatus**，状态枚举：`pending → running → done/failure`。

## 构成

```
NACAB
├── bus: EventBus
├── handlers: Map<AbilityName, AbilityHandler>
│   └── register
├── byId: Map<Id, AbilityInstance>
└── nacpAdaptor
```

和 NACEB 一样，`bus` 对外只暴露只读口 `eventBusObs`。handlers 只有 register。

byId 存每次 invoke 的 AbilityInstance，供后续 `getTask(id)` 查询。

## 执行模型

NACAB 没有 tick、没有队列调度、没有并发控制。每个 `invoke` 是独立的异步调用：

1. 查 handler、new AbilityInstance、入 byId。
2. status = pending，emit `nacab:task:running:before:{id}`。
3. status = running，emit `nacab:task:running:after:{id}`。
4. `await handler.execute()`。
5. 正常返回 → status = done，emit `nacab:task:done:after:{id}`，return result。
6. 抛出异常 → status = failure，emit `nacab:task:failure:after:{id}`，throw error。

并发调用互不影响。如果调用者需要串行，自己在外部 await。

## EventBus

NACAB 的 EventBus 和 NACEB 全部一致。

### T 事件

格式 `nacab:task:{state}:{phase}:{id}`。`this` 是 AbilityInstance 的只读视图，payload 默认为空。

<table class="hooks">
<tr><th>key 模式</th><th>this（只读视图）</th><th>状态</th><th>前缀</th><th>全称</th></tr>
<tr><td class="st" rowspan="6"><code>nacab:task:<br>{state}:{phase}:{id}</code></td><td class="st" rowspan="6">AbilityInstance</td><td class="st" rowspan="2">running</td><td class="bf">before</td><td>nacab:task:running:before:{id}</td></tr>
<tr><td class="af">after</td><td>nacab:task:running:after:{id}</td></tr>
<tr><td class="st" rowspan="2">done</td><td class="bf">before</td><td>nacab:task:done:before:{id}</td></tr>
<tr><td class="af">after</td><td>nacab:task:done:after:{id}</td></tr>
<tr><td class="st" rowspan="2">failure</td><td class="bf">before</td><td>nacab:task:failure:before:{id}</td></tr>
<tr><td class="af">after</td><td>nacab:task:failure:after:{id}</td></tr>
</table>

### 运行时事件

统一 `nacab:runtime:{level}:{id}`，payload 统一 `{ layer, id, msg?, opt? }`。**这类事件有单独的payload，没有绑定this**。

| key | 触发时机 | {id} |
|-----|---------|------|
| `nacab:runtime:error:bus` | EventBus observer 抛出 | — |

NACAB 没有 `message` 事件（无过程输出流）。

## API

| 方法 | 签名 | 说明 |
|---|---|---|
| `register` | `(h: AbilityHandler) => void` | 按 h.name 注册；重名会覆盖 |
| `invoke` | `(name: string, input: unknown) => Promise<unknown>` | 未知 name 抛 NACABError(inbound)；handler 异常 reject |
| `getTask` | `(id: string) => AbilityInstance \| null` | 按 id 查执行记录 |
| `getAllAbilities` | `() => Ability[]` | 返回 `{name, description}[]`，供 NACP 声明 |
| `eventBusObs` | `ReadonlyBus` | 只读观测口 |

## 与 NACP 的关系

NACAB 暴露 `nacpAdaptor`（实现 `Processor`），由 NACP 绑定：

```ts
ncp.bindProcessor('ability', nacab.nacpAdaptor)
```

adaptor 只完成以下能力的转换
- `list()` → `getAllAbilities()
- `push(spec, hooks)` → `await nacab.invoke(spec.target, spec.payload)`
- `.then` → `hooks.onResponse(result, true)`
- `.catch` → `hooks.onResponse(undefined, false, error)`。

## 开发者对接

### 注册 Handler

```ts
class Add extends AbilityHandler {
  name = 'math.add'
  description = 'add two numbers'
  async execute() { return this.input.a + this.input.b }
}
const nacab = new Nacab({ handlers: [new Add()] })
```

`execute()` 的 `this` 是 AbilityInstance，和NACEB一致可以保存状态，只不过任务结束后会连同Instance一起被销毁。

### 调用

```ts
const result = await nacab.invoke('math.add', { a: 1, b: 2 }) // = 3
try { await nacab.invoke('boom', null) } catch (e) { /* e = 'boom!' */ }
```

### 监听 EventBus

```ts
nacab.eventBusObs.listen('nacab:task:done:after:*', function() {
  console.log('done:', this.id, this.result)
  const t = nacab.getTask(this.id)
  console.log('consume:', t.result) // consume 不是必须的，但从 byId 清理时可以调 t.consume()
})
```

