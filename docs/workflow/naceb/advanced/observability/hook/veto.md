# Veto

Veto是NACEB取消当前状态转移的控制机制，仅能在特定的before THook中使用。

```ts
import { VetoT } from '@chenyfan/nasdk/NACEB'

event.beforeTActivating(function () {
  if (!ready()) throw new VetoT('not ready')
})
```

NACEB通过`instanceof VetoT`识别Veto。

:::tip
Veto不是业务错误，也不能用普通`Error`代替。
:::

## 发生 Veto 时

一个可否决的before THook抛出`VetoT`后：

1. 停止执行剩余的before Hook。
2. 不执行本次转移副作用。
3. 不更新Instance状态。
4. 不广播after T Event，也不执行after Hook。
5. 广播一条`naceb:runtime:warning:{id}`。

例如，在`beforeTActivating()`否决后，本刻不会创建PipelineInstance，Event仍停留在`queue`。

:::danger
但是，如果使用Veto机制，则需要注意：

1. 否决在生效后不会自动撤掉原来的Hook。
2. 由于1的原因，如果否决成功后下一次状态转移还是不符合否决的条件，则会立刻触发下一次否决。

换句话说，请**在否决前修改数据以防止下一次被否决**。
:::

## 可否决点

| 层       | 可否决点                            | 否决结果                          |
| -------- | ----------------------------------- | --------------------------------- |
| Event    | 非终局的before THook                | 取消当前转移，保持原状态          |
| Event    | `beforeTDone()`、`beforeTFailure()` | 不可否决；降级为warning并继续转移 |
| Pipeline | 无                                  | 任何抛出都按Hook错误处理          |
| Task     | 仅`beforeTRunning()`                | 保持`pending`，不调用TaskHandler  |

Veto只在before THook中有意义。after Hook运行时转移已经完成，其异常只会上报，不会回滚状态。

## 重试

Veto只取消当前转移，不负责重放触发它的操作。

| 转移来源             | Veto后行为                                   |
| -------------------- | -------------------------------------------- |
| Controller在刻中发起 | 本刻仍报告发生推进，触发快进刻并重新检查条件 |
| `start()`            | Event留在`idle`，需要再次调用`start()`       |
| `pause()`            | 返回`false`，需要调用方决定是否重试          |
| `resume()`           | 返回`false`，需要调用方处理恢复失败          |

Task的`beforeTRunning()`由TaskFSMController驱动，被否决后会在后续刻重新检查Lane条件并重试。

## 修改条件后否决

Controller在调用before Hook之前已经完成本次转移的条件判断。

要修改调度条件，应先修改数据，再否决当前决定：

```ts
event.beforeTActivating(function () {
  this.scope = 'exclusive'
  throw new VetoT('recheck scope')
})
```

Event保持在`queue`，下一刻会使用新的`scope`重新判断是否可以激活。

:::warning
不要无条件抛出`VetoT`。Controller驱动的转移会快速重试，无收敛条件的Veto会形成连续空转。
:::

## 终局不可否决

Event进入`done`或`failure`时，下层Pipeline已经终局。即使取消本次转移，下一刻仍会读到相同的终局结果，无法产生新的决策。

因此`beforeTDone()`和`beforeTFailure()`中的`VetoT`只会产生warning，NACEB仍会消费Pipeline并完成Event转移。

如果不希望Pipeline结束，应在[PipelineHandler](../../../registration/pipeline-handler)中决定是否派发`$terminal`，或在Task的`beforeTRunning()`阻止下一步执行。

## 与 Hook 错误的区别

before Hook抛出的其他异常属于Hook错误：

| 层       | 结果                                            |
| -------- | ----------------------------------------------- |
| Event    | 先终止并消费下层Task和Pipeline，再进入`failure` |
| Pipeline | 当前Pipeline进入`failure`，后续由Event层同步    |
| Task     | 当前Task进入`failure`，后续由Pipeline层同步     |

如果错误发生在`beforeTFailure()`中，NACEB会移除该组Hook后再次进入`failure`，避免递归触发。

Hook的挂载、执行顺序和可观测T Event见[Hook](../hook)。
