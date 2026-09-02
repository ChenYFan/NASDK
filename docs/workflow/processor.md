# NASDK Processor

Processor是NACP与任务处理器之间的统一接口。

NACP只依赖Processor，不直接依赖NACEB或NACAB。任何实现对应Processor接口的处理器都可以绑定到NApp。

## 接口

```ts
import type {
  Processor,
  ProcessorHooks,
  ProcessorSpec,
} from '@chenyfan/nasdk/types'

interface Processor {
  list(): { name: string; description: string }[]
  push(spec: ProcessorSpec, hooks: ProcessorHooks): string | void
}

interface ProcessorSpec {
  target: string
  payload: unknown
  reqId: string
}

interface ProcessorHooks {
  onProcess(chunk: unknown): void
  onResponse(result: unknown, isOk: boolean, whyNotOk?: string): void
}
```

### ProcessorSpec

| 字段 | 作用 |
| --- | --- |
| `target` | 要调用的Event或Ability名称 |
| `payload` | 不透明的业务输入 |
| `reqId` | NACP Request ID，用于关联过程消息、结果与信号 |

### ProcessorHooks

| 回调 | 作用 |
| --- | --- |
| `onProcess()` | 提交一条过程消息；NACP将其映射为Notify |
| `onResponse()` | 提交唯一终局结果；NACP将其映射为Response |

`whyNotOk`只描述协议层结果，例如`processor-rejected`或`processor-failed`。具体错误信息应放在`result`中。

## 调用流程

```text
NACP Request
  → Processor.push(spec, hooks)
  → 任务处理器
      → hooks.onProcess(chunk)  → NACP Notify
      → hooks.onResponse(...)   → NACP Response
```

`push()`可以返回处理器内部ID，但NACP不会使用该返回值。NACP始终通过`reqId`管理协议请求。

`list()`返回本Processor提供的名称与描述。NApp未显式配置`decl`时，会从绑定的Processor生成Event与Ability声明。

## 具体接口

| 请求类型 | 接口 | 额外能力 | NASDK默认实现 |
| --- | --- | --- | --- |
| Event | [EventProcessor](./processor/event-processor) | `signal()` | NACEB的`nacpAdaptor` |
| Ability | [AbilityProcessor](./processor/ability-processor) | `register()` | NACAB的`nacpAdaptor` |

NACEB与NACAB本身可以脱离NApp使用。只有它们各自的`nacpAdaptor`实现Processor接口。

## 绑定到 NApp

```ts
app.bindProcessor('event', eventProcessor)
app.bindProcessor('ability', abilityProcessor)
```

一个NApp对每种请求类型只绑定一个Processor。再次绑定会替换该类型当前的Processor。

调用`app.start()`时，未绑定的请求类型会自动创建默认空NACEB或NACAB，并将其Adaptor绑定到NApp。默认实例可通过`app.default.NACEB`和`app.default.NACAB`取得。
