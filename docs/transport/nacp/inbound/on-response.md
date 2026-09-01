# onResponse

`onResponse()` 负责使用入站的 [`ResponseMessage`](/transport/nacp/message#responsemessage) 结算对应的等待方。

```ts
NApp.nacp.onResponse(
  message,
): void
```

| 参数      | 说明                    |
| --------- | ----------------------- |
| `message` | 入站的 ResponseMessage  |

## 行为

### AutoSubscribe 清理

当 `message.meta.kind` 为 `event` 时，`onResponse()` 会用 `message.meta.parentId` 清理请求方持有的 [AutoSubscribe](/transport/nacp/auto-subscribe) 记录，并结束过程流。

其他操作的 Response 不执行这一步。

### 查找等待方

`message.meta.parentId` 指向被响应消息的 `id`。`onResponse()` 使用该 ID 查找并移除对应的 Response 等待记录。

找不到等待方时，会报告 `has-no-consumer`。Response 的 ACK 已由统一入站流程发送，不会因此重复回复。

### 结束时

当 `message.meta.isOk` 为 `true` 时，等待中的 Promise 使用完整的 ResponseMessage resolve；为 `false` 时，使用 `message.meta.whyNotOk` reject。

发送方向见 [`response()`](../outbound/response)。
