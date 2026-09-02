# $fire4SubEvent

`$fire4SubEvent`派发一个SubEvent，但不等待其完成。

## 接口

| 属性 | 值                    |
| ---- | --------------------- |
| 名称 | `$fire4SubEvent`      |
| 类型 | AsyncTask             |
| 输入 | `SubEventSpec`        |
| 输出 | `{ childId: string }` |

```ts
interface SubEventSpec {
  pipelineName: string
  payload: unknown
}
```

## 行为

该Task创建并启动子Event，写入指向当前Event的`parentId`，随后立即返回`childId`。

父Pipeline取得结果后继续下一步，子Event终局后由NACEB自动消费，其失败不会改变父Event的状态。

## 使用

```ts
next() {
  return { // [!code focus:7]
    task: '$fire4SubEvent',
    input: {
      pipelineName: 'child-pipeline',
      payload: { value: 1 },
    },
  }
}
```

父子Event关系和输入限制见[SubEvent](../advanced/subevent)。
