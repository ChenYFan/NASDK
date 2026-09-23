# NACT Framing

NACT在构造完整数据的时候会进行切片、分帧。

无论是否切片，NACT 都会为每个帧增加 32 Bytes Header。

## NACT 消息头

<div style="overflow-x: auto">
<table style="display: table; overflow: visible; min-width: 960px; table-layout: fixed; text-align: center">
    <thead>
      <tr>
        <th style="width: 72px">Offset</th>
        <th>+0</th><th>+1</th><th>+2</th><th>+3</th>
        <th>+4</th><th>+5</th><th>+6</th><th>+7</th>
        <th>+8</th><th>+9</th><th>+A</th><th>+B</th>
        <th>+C</th><th>+D</th><th>+E</th><th>+F</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <th><code>0x00</code></th>
        <td colspan="16"><code>msgId</code><br>16 B</td>
      </tr>
      <tr>
        <th><code>0x10</code></th>
        <td colspan="4"><code>offset</code><br>4 B</td>
        <td colspan="4"><code>totalSize</code><br>4 B</td>
        <td colspan="4"><code>thisFrameSize</code><br>4 B</td>
        <td colspan="2"><code>blank</code><br>2 B</td>
        <td><code>magic</code><br>1 B</td>
        <td><code>version</code><br>1 B</td>
      </tr>
    </tbody>
</table>
</div>

Frame Body 紧跟在 32B Header 后，从 `0x20` 开始，长度为 `thisFrameSize - 32`。

| Offset | 长度 | 字段            | 编码       | v1 值    | 含义                                                           |
| ------ | ---- | --------------- | ---------- | -------- | -------------------------------------------------------------- |
| 0      | 16   | `msgId`         | 16 bytes   | -        | 同一**NACP**消息所有片相同                                     |
| 16     | 4    | `offset`        | uint32, BE | —        | 本片在整条消息中的起始字节                                     |
| 20     | 4    | `totalSize`     | uint32, BE | —        | 整条消息长度                                                   |
| 24     | 4    | `thisFrameSize` | uint32, BE | —        | **本片总长，含这 32B 头**，故 `bodyLen = thisFrameSize - 32`。 |
| 28     | 2    | `blank`         | uint16, BE | `0x0000` | 预留给未来的指示位                                             |
| 30     | 1    | `magic`         | uint8      | `0xCF`   | 魔数                                                           |
| 31     | 1    | `version`       | uint8      | `0x01`   | NACT Message版本                                               |



:::danger

由于totalSize只包含4Bytes，因此最大的长度只有2^(4\*8)-1 Bytes，即约4GB。换句话说NACT理论上最大能承载一个4GB的消息发送。

这个数字其实是原先Node20对Buffer的最大限制，尽管在Node24中上限被提高到了8PB。

不过，实际传输中这个限制被NACP进一步调低，默认是2GB。

**（NASDK v1.0.3，NACT v1）** 未来可能会通过增加头部长度、缩短msgID或利用Blank字段提升长度限制。~~但是至少最近一段时间不会考虑修改NACT~~

:::

## 分片与重组

NACT 内有分片机制，对于一个较大的Payload消息，NACT会切分为多个帧按序发送。

分片阈值来自 `TransportSpec.nact.chunkSize`，省略时使用当前 Provider 声明的推荐默认值。

不同 Provider 可以推荐不同阈值，但不能改变 Header 或重组语义。

NACT 分片用于穿透物理传输中间层的单次提交上限，同时进一步降低发送端合并产生的内存峰值。

:::details
1GB payload 实测：

| provider | 分片       | wire (ms) | 接收端内存峰值 |
| ---- | ---------- | --------- | -------------- |
| unix | 不分片     | 665       | 1024 MB        |
| unix | 100MB × 11 | 668       | 1024 MB        |
| tcp  | 不分片     | 734       | 1024 MB        |
| tcp  | 100MB × 11 | 667       | 1024 MB        |
| ws   | 不分片     | 2784      | 3027 MB        |
| ws   | 100MB × 11 | 3931      | **1147 MB**    |

Q：这里为什么会x11

A：因为NACT保证的是**添加头之后产出的包最大是100MB**，所以每次只会截取`100MB-32B`的数据，最后还有`32B+320B`数据需要单独发送。
:::
