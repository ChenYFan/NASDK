# SubEvent

SubEvent是由一个Event在处理过程中派发的独立子Event。

subEvent和普通Event的差异仅包括：

- 存在`parentId`记录父Event ID
- 不继承，也不能设置`scope`与`blockedBy`

其余内容和普通Event无异。

## 接口

Pipeline通过`SubEventSpec`描述要派发的子Event：

```ts
interface SubEventSpec {
  pipelineName: string
  payload: unknown
}
```

## 派发方式

NACEB提供两个内建TaskHandler派发SubEvent：

|             | [`$fire4SubEvent`](../builtins/fire4subevent) | [`$wait4SubEvent`](../builtins/wait4subevent) |
| ----------- | --------------------------------------------- | --------------------------------------------- |
| 父Pipeline  | 立即继续                                      | 等待子Event终局                               |
| Task结果    | `{ childId }`                                 | 子Event的终局结果                             |
| 子Event消费 | 自动消费                                      | 由父Task消费                                  |
| 子Event失败 | 不影响父Event                                 | 使父Task进入`failure`                         |

两者都会创建子Event、写入`parentId`并自动调用`start()`。

区别仅在父Event的Pipeline是否等待子Event结果。

## 使用

```ts
next() {
  return {
    task: '$fire4SubEvent',
    input: {
      pipelineName: 'child-pipeline',
      payload: { value: 1 },
    },
  }
}
```
