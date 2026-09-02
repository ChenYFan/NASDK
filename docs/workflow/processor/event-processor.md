# EventProcessor

EventProcessor处理具有生命周期的Event请求，在Processor基础上增加中途信号。

## 接口

```ts
import type {
  EventProcessor,
  ProcessorSignalSpec,
} from '@chenyfan/nasdk/types'

interface EventProcessor extends Processor {
  signal(spec: ProcessorSignalSpec): Promise<void>
}

type ProcessorSignalSpec =
  | {
      signalId: string
      reqId: string
      kind: 'normal'
      payload: unknown
    }
  | {
      signalId: string
      reqId: string
      kind: 'pause' | 'resume' | 'abort'
    }
```

EventProcessor可以多次调用`onProcess()`，但只能通过`onResponse()`提交一个终局结果。

## 默认实现

NACEB通过`naceb.nacpAdaptor`提供默认EventProcessor：

```ts
app.bindProcessor('event', naceb.nacpAdaptor)
```

Adaptor只使用NACEB公开接口，将Processor操作映射到EventInstance。

### list

`list()`返回`naceb.listEventAlias()`，使EventAlias中的名称与描述进入NApp声明。

### push

```text
Processor.push(spec, hooks)
  → pushEvent({ name: spec.target, payload: spec.payload })
  → Event停在idle
  → 监听runtime:message
  → 挂载afterTDone与afterTFailure
  → 保存reqId ↔ eventId
  → Event.start()
```

Adaptor保留`idle`窗口，不使用`bypassIdle`。过程消息Listener与终局Hook会在第一次状态转移前挂载，避免丢失同步完成的Event结果。

## 输出映射

| NACEB输出 | Processor回调 | NACP消息 |
| --- | --- | --- |
| `processingResultReport(chunk)` | `onProcess(chunk)` | Notify |
| Event `done` | `onResponse(result, true)` | 成功Response |
| Event `failure` | `onResponse(result, false, 'processor-failed')` | 失败Response |

Event终局时，Adaptor会移除过程消息Listener、删除ID映射并消费EventInstance。

Event创建前失败时，没有EventInstance可以进入终局。Adaptor会直接调用：

```ts
hooks.onResponse(
  { error: errorDetail(error) },
  false,
  'processor-rejected',
)
```

`processor-rejected`表示请求没有开始；`processor-failed`表示请求已经进入NACEB并以失败终局。

## ID 隔离

NACP使用`reqId`关联远端Request，NACEB使用`eventId`管理本地EventInstance。Adaptor内部保存两者映射：

```text
reqId ↔ eventId
```

`eventId`不会作为协议ID交给NACP，`push()`的返回值也不会被NACP使用。

## 信号映射

`signal()`按`reqId`找到仍然活跃的EventInstance：

| `kind` | NACEB操作 |
| --- | --- |
| `normal` | `event.normalSIG()`，交给PipelineHandler的`onNormalSIG()` |
| `pause` | `event.pause()` |
| `resume` | `event.resume()` |
| `abort` | `event.abort()` |

信号执行前会广播`naceb:runtime:signal:{eventId}`。找不到活跃Event，或暂停、恢复未成功时，`signal()`会抛错。

NACP如何接收并调用Processor见[onRequest](/transport/nacp/inbound/on-request)与[onSignal](/transport/nacp/inbound/on-signal)。
