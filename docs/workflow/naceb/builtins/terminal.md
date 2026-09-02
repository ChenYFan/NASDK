# $terminal

`$terminal`结束当前Pipeline，并将输入作为Pipeline的最终结果。

## 接口

| 属性 | 值          |
| ---- | ----------- |
| 名称 | `$terminal` |
| 类型 | AsyncTask   |
| 输入 | 任意值      |
| 输出 | -           |

## 行为

Pipeline必须以`$terminal`正常结束。

该Task完成后，Pipeline进入`done`，其输入保存为Pipeline最终结果，并继续交给Event层。

`PipelineHandler.next()`返回`undefined`不会结束Pipeline，而会使其进入`failure`。

## 使用

```ts
next(lastResult) {
  return { // [!code focus:4]
    task: '$terminal',
    input: lastResult,
  }
}
```
