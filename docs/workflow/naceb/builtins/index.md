# 内建 Task

NACEB内建三个以`$`开头的TaskHandler：

| Task | 作用 |
| --- | --- |
| [`$terminal`](./terminal) | 结束当前 Pipeline 并返回结果 |
| [`$fire4SubEvent`](./fire4subevent) | 派发子 Event，不等待其完成 |
| [`$wait4SubEvent`](./wait4subevent) | 派发子 Event，并等待其结果 |

`$`前缀由NACEB保留，不能用于注册普通TaskHandler。

`$fire4SubEvent`与`$wait4SubEvent`涉及的父子Event关系见[SubEvent](../advanced/subevent)。
