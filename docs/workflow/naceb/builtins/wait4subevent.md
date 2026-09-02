# $wait4SubEvent

`$wait4SubEvent`派发一个SubEvent，并等待其终局结果。

## 接口

| 属性 | 值                |
| ---- | ----------------- |
| 名称 | `$wait4SubEvent`  |
| 类型 | AsyncTask         |
| 输入 | `SubEventSpec`    |
| 输出 | 子Event的终局结果 |

```ts
interface SubEventSpec {
  pipelineName: string
  payload: unknown
}
```

## 行为

该Task创建并启动子Event，写入指向当前Event的`parentId`，并**等待**子Event终局：

| 子Event结果 | 当前Task结果                      |
| ----------- | --------------------------------- |
| `done`      | 消费子Event，并以其结果进入`done` |
| `failure`   | 消费子Event，并进入`failure`      |

当前Task收到中止信号时停止等待，并以`stopped`收尾。

## 使用

```ts
next() {
  return { // [!code focus:7]
    task: '$wait4SubEvent',
    input: {
      pipelineName: 'child-pipeline',
      payload: { value: 1 },
    },
  }
}
```

父子Event关系、输入限制及其与`$fire4SubEvent`的区别见[SubEvent](../advanced/subevent)。
