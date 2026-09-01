# onRequest

`onRequest()` 负责将入站的 [`RequestMessage`](/transport/nacp/message#requestmessage) 移交给对应的 Processor。

```ts
NApp.nacp.onRequest(
  message,
): void
```

| 参数      | 说明                  |
| --------- | --------------------- |
| `message` | 入站的 RequestMessage |

## 行为

### AutoSubscribe 构建

当 `message.meta.kind` 为 `event` 时，`onRequest()` 会先用 Request 的 `id` 作为 `subId`，构建 [AutoSubscribe](/transport/nacp/auto-subscribe) 的被请求方记录。

Ability Request 不构建 AutoSubscribe。

### 移交 Processor

`onRequest()` 根据 `message.meta.kind` 选择 Event Processor 或 Ability Processor，并移交：

```ts
{
  target: message.meta.target ?? "",
  payload: message.payload,
  reqId: message.id,
}
```

找不到对应 Processor 时，会报告 `no-processor`，并向请求方发送失败的 Response。

Processor 的具体接口与行为见 [Processor](/workflow/processor)。

### 过程流

Processor 产生过程数据时，NACP 将其转换为 [`NotifyMessage`](/transport/nacp/message#notifymessage) 并发送。

只有 Event Request 建立了 AutoSubscribe，因此 Ability Request 没有过程流。

### 结束时

Processor 结束时，NACP 将处理结果转换为 [`ResponseMessage`](/transport/nacp/message#responsemessage)，其中 `parentId` 指向 Request 的 `id`。

对于 Event Request，Response 发出时会同时清理被请求方的 [AutoSubscribe](/transport/nacp/auto-subscribe) 记录。

发送方向见 [`request()`](../outbound/request)，Response 到达请求方后的处理见 [`onResponse()`](./on-response)。
