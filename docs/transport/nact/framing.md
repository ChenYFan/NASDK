# NACT Framing

NACT 会把一个 NACP 包分片成一个或多个 NACT 帧。

无论是否需要分片，每一帧NACT都会额外添加长度为 32 Bytes 的帧头。

## NACT 帧头

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

帧体紧跟在 32B 帧头后，从 `0x20` 开始，长度为 `thisFrameSize - 32`。

| Offset | 长度 | 字段            | 编码       | v1 值    | 含义                                                           |
| ------ | ---- | --------------- | ---------- | -------- | -------------------------------------------------------------- |
| 0      | 16   | `msgId`         | 16 bytes   | -        | 同一 **NACP 包**的所有帧相同                                  |
| 16     | 4    | `offset`        | uint32, BE | —        | 本帧在所属 NACP 包中的起始字节                                 |
| 20     | 4    | `totalSize`     | uint32, BE | —        | 所属 NACP 包的总长度                                           |
| 24     | 4    | `thisFrameSize` | uint32, BE | —        | **本帧总长，含这 32B 帧头**，故 `bodyLen = thisFrameSize - 32`。 |
| 28     | 2    | `blank`         | uint16, BE | `0x0000` | 预留给未来的指示位                                             |
| 30     | 1    | `magic`         | uint8      | `0xCF`   | 魔数                                                           |
| 31     | 1    | `version`       | uint8      | `0x01`   | NACT Message版本                                               |



:::danger


**feat: NACT对单帧和单包的大小限制分别为2GB和4GB**

由于`totalSize`长度仅4Bytes，因此最大的长度只有2^(4\*8)-1 Bytes，即约4GB。

这个数字其实是原先Node20对Buffer的最大限制，尽管在Node24中上限被提高到了8PB。

此外 `thisFrameSize` 超过 `MAX_FRAME_SIZE`（默认 2 GiB）则会出现 `frame-too-large`错误。

本特性在 **（NASDK v1.0.4，NACT v1）** 仍存在。未来可能会通过增加头部长度、缩短msgID或利用Blank字段提升长度限制。~~但是至少最近一段时间不会考虑修改NACT~~

:::

## 分帧与重组

NACP 包超过分片阈值时，NACT 会把它分片成多个帧依次发送。

分片阈值来自 `TransportSpec.nact.chunkSize`，省略时使用当前 Provider 声明的推荐默认值。

分片的目的是为了穿透物理传输中间层的单次提交上限（如部分CDN限制100MB上传之类的），同时进一步降低发送端合并产生的内存峰值。

:::tip
NACP默认分片大小是100MB，但UnixSocket默认不分片。
:::

:::details
1GB payload 实测：

| provider | 分帧       | wire (ms) | 接收端内存峰值 |
| ---- | ---------- | --------- | -------------- |
| unix | 一帧       | 665       | 1024 MB        |
| unix | 100MB × 11 | 668       | 1024 MB        |
| tcp  | 一帧       | 734       | 1024 MB        |
| tcp  | 100MB × 11 | 667       | 1024 MB        |
| ws   | 一帧       | 2784      | 3027 MB        |
| ws   | 100MB × 11 | 3931      | **1147 MB**    |

Q：这里为什么会x11

A：因为这一组测试把 `chunkSize` 设为 100MB，NACT 保证**加上帧头后每一帧不超过 100MB**，所以每帧只装 `100MB-32B` 的数据，余下的 `320B` 单独成一帧（`32B` 帧头 + `320B`）。
:::
