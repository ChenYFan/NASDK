# NACAB

NACAB全称Nyirusu Application Control Ability Bus，是NASDK内建的Ability处理器。

它用于一次调用、一次返回的独立能力：按名称查找AbilityHandler，执行后直接返回结果。

```text
invoke(name, input)
  → AbilityHandler.execute()
  → result或error
```

NACAB没有Pipeline、队列、刻、资源调度、Hook或Veto。每次调用都会创建独立的AbilityInstance，不同调用可以并发执行。

## 构成

```text
NACAB
├── AbilityHandler注册表
├── AbilityInstance
├── EventBus
└── NACPAdaptor
```

| 部分 | 作用 |
| --- | --- |
| AbilityHandler | 定义Ability名称、描述与执行逻辑 |
| AbilityInstance | 保存单次调用的输入、状态与结果 |
| EventBus | 观测执行状态和错误 |
| NACPAdaptor | 实现[AbilityProcessor](./processor/ability-processor)接口 |

## 使用

```ts
import { NACAB, AbilityHandler } from '@chenyfan/nasdk/NACAB'

class Add extends AbilityHandler<number> {
  readonly name = 'math.add'
  readonly description = '两数相加'

  async execute() {
    const { a, b } = this.input as { a: number; b: number }
    return a + b
  }
}

const nacab = new NACAB({ handlers: [new Add()] })
const result = await nacab.invoke('math.add', { a: 1, b: 2 })
```

Ability的定义方式见[注册Ability](./nacab/registration)，执行过程和可观测Event见[调用与观测](./nacab/invocation)。

:::tip
NACAB可以脱离NApp独立使用。接入NACP时绑定`nacab.nacpAdaptor`，详见[AbilityProcessor](./processor/ability-processor)。
:::
