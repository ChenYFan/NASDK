# AbilityProcessor

AbilityProcessor处理一次调用、一次返回的Ability请求，并提供Ability注册入口。

## 接口

```ts
import type { AbilityProcessor } from '@chenyfan/nasdk/types'

interface AbilityProcessor extends Processor {
  register(item: AbilityProcessorHandler): void
}

interface AbilityProcessorHandler {
  name: string
  description: string
  execute(payload: unknown): unknown | Promise<unknown>
}
```

Ability没有过程消息或中途信号，因此通常不会调用`onProcess()`。

## 默认实现

NACAB通过`nacab.nacpAdaptor`提供默认AbilityProcessor：

```ts
app.bindProcessor('ability', nacab.nacpAdaptor)
```

### list

`list()`返回`nacab.listAbility()`，使已注册Ability的名称与描述进入NApp声明。

### push

Adaptor将Processor调用直接映射到`nacab.invoke()`：

```text
Processor.push(spec, hooks)
  → nacab.invoke(spec.target, spec.payload)
      → fulfilled → hooks.onResponse(result, true)
      → rejected  → hooks.onResponse(
                       { error },
                       false,
                       'processor-failed',
                     )
```

未知Ability和Handler执行异常都使用`processor-failed`。具体错误信息放在Response payload，不放入`whyNotOk`。

### register

`register(item)`原样转发给`nacab.register(item)`。

绑定AbilityProcessor时，NApp会通过该入口注册自己的`NApp.*`内建Ability。因此自定义AbilityProcessor必须实现`register()`。

NACP如何接收并调用Processor见[onRequest](/transport/nacp/inbound/on-request)。
