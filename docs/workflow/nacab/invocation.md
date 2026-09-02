# 调用与观测

`invoke()`按名称执行Ability，并返回Handler结果：

```ts
const result = await nacab.invoke('math.add', { a: 1, b: 2 })
```

未知Ability会抛出`NACABError`。Handler执行失败时，`invoke()`原样抛出Handler的错误对象。

## AbilityInstance

每次`invoke()`创建一个独立AbilityInstance：

```ts
class AbilityInstance {
  readonly id: string
  readonly input: unknown
  readonly state: Record<string, any>

  status: 'pending' | 'running' | 'done' | 'failure'
  result?: unknown
  error?: unknown
}
```

Instance只在本次调用中存活。NACAB不保存ID到Instance的查询表，调用结束后由调用栈释放。

## 执行过程

```text
查找AbilityHandler
  → 创建AbilityInstance（pending）
  → running
  → await AbilityHandler.execute()
      → done：保存并返回result
      → failure：保存并抛出error
```

NACAB没有队列或并发限制。多个`invoke()`相互独立；需要串行时由调用方逐个`await`。

## 可观测 Event

NACAB使用独立EventBus。外部通过`nacab.eventBusObs`监听和取消：

```ts
const listenerId = nacab.eventBusObs.listen(key, listener)
nacab.eventBusObs.off(listenerId)
```

### T Event

```text
nacab:ability:{state}:{phase}:{id}
```

| 片段 | 取值 |
| --- | --- |
| `state` | `running`、`done`或`failure` |
| `phase` | `before`或`after` |
| `id` | AbilityInstance ID |

AbilityInstance创建时直接处于`pending`，不会广播`pending` T Event。T Event的payload为`undefined`，Listener的`this`是AbilityInstance的浅层只读视图。

```ts
nacab.eventBusObs.listen(
  'nacab:ability:done:after:*',
  function (this: AbilityInstance) {
    console.log(this.id, this.result)
  },
)
```

NACAB没有THook。T Event只用于观测，不能阻塞或否决状态转移。

### Runtime Event

| key | 时机 |
| --- | --- |
| `nacab:runtime:log:{id}` | AbilityInstance创建或正常完成 |
| `nacab:runtime:error:{id}` | Handler执行失败 |
| `nacab:runtime:error:{name}` | 未注册对应Ability |
| `nacab:runtime:error:bus` | EventBus Listener执行失败 |

Runtime Event的payload使用`{ layer, id, msg?, opt? }`，不将Instance绑定到`this`。EventBus的通用监听方式见[EventBus API](/napp/eventbus/bus)。
