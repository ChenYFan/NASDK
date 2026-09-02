# 注册 Ability

NACAB支持AbilityHandler和闭包两种注册方式。两者写入同一张注册表，名称重复时后注册者覆盖已有项。

## AbilityHandler

```ts
abstract class AbilityHandler<R = unknown> {
  abstract readonly name: string
  abstract readonly description: string
  abstract execute(this: AbilityInstance): Promise<R>
}
```

```ts
import { NACAB, AbilityHandler } from '@chenyfan/nasdk/NACAB'

class Add extends AbilityHandler<number> { // [!code focus:9]
  readonly name = 'math.add'
  readonly description = '两数相加'

  async execute() {
    const { a, b } = this.input as { a: number; b: number }
    return a + b
  }
}

const nacab = new NACAB({ handlers: [new Add()] })
```

Handler是无状态、可复用的逻辑定义。`execute()`的`this`绑定到当前AbilityInstance：

| 成员 | 作用 |
| --- | --- |
| `this.id` | 本次调用的唯一ID |
| `this.input` | 本次调用输入 |
| `this.state` | 本次调用的临时状态空间 |
| `this.status` | 当前执行状态 |

因此`execute()`应使用普通方法，不应使用箭头函数。`state`只在本次调用期间存活。

构造后也可以注册：

```ts
nacab.registerHandler(new Add())
```

## 闭包注册

```ts
nacab.register({
  name: 'math.add',
  description: '两数相加',
  execute: input => {
    const { a, b } = input as { a: number; b: number }
    return a + b
  },
})
```

闭包只接收输入，不绑定AbilityInstance。该形式用于[AbilityProcessor](../processor/ability-processor)的`register()`接口，也是NApp注册`NApp.*`内建Ability的入口。

## 声明

```ts
const abilities = nacab.listAbility()
```

`listAbility()`返回所有Handler的`name`与`description`，供NApp生成Ability声明。
