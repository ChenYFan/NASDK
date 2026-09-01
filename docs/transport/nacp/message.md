# NACPMessage

NACPMessage是设计为统一具体的方法的最终格式。

通过不同的type来构造和继承基本类型，并由此决定meta数据的构造。

```ts
interface NACPBaseMessage {
  v: { major: number; minor: number }
  type: NACPType
  id: string
  from: string
  to: string
  t: number
  meta: BaseMeta
  payload?: unknown
}
```

## RequestMessage

```ts
interface RequestMeta extends BaseMeta {
  kind: "event" | "ability"
  target?: string // 具体的事件名或能力名
}

interface RequestMessage extends NACPBaseMessage {
  type: "request"
  meta: RequestMeta
  payload: UnknownPayload
}
```

## ResponseMessage

```ts
interface ResponseMeta extends BaseMeta {
  parentId: string
  isOk: boolean
  whyNotOk?: string
  kind?: "event" | "ability"
}

interface ResponseMessage extends NACPBaseMessage {
  type: "response"
  meta: ResponseMeta
  payload: ResponsePayloadUnion
}
```

:::tip
`parentId` 指向被响应消息的 `id`。

`kind` 仅在响应 Request 时使用。
:::

## SignalMessage

```ts
interface SignalMeta extends BaseMeta {
  parentId: string
  kind: "normal" | "pause" | "resume" | "abort"
}

interface NormalSignalMessage extends NACPBaseMessage {
  type: "signal"
  meta: SignalMeta & { kind: "normal" }
  payload: UnknownPayload
}

interface ControlSignalMessage extends NACPBaseMessage {
  type: "signal"
  meta: SignalMeta & { kind: "pause" | "resume" | "abort" }
  payload?: undefined
}

type SignalMessage = NormalSignalMessage | ControlSignalMessage
```

:::tip
`parentId` 指向目标 Event Request 的 `reqId`。

控制类 Signal 不包含 `payload` 字段。
:::

## SubscribeMessage

```ts
interface SubscribeMeta extends BaseMeta {}

interface SubscribePayload extends BasePayload {
  targetSubName: string
}

interface SubscribeMessage extends NACPBaseMessage {
  type: "subscribe"
  meta: SubscribeMeta
  payload: SubscribePayload
}
```

:::tip
`subscribe` 消息 `id` 同时作为该订阅的 `subId`。
:::

## UnsubscribeMessage

```ts
interface UnsubscribeMeta extends BaseMeta {}

interface UnsubscribePayload extends BasePayload {
  targetSubId: string
}

interface UnsubscribeMessage extends NACPBaseMessage {
  type: "unsubscribe"
  meta: UnsubscribeMeta
  payload: UnsubscribePayload
}
```

:::tip
`targetSubId` 是要取消的 SubscribeMessage ID。
:::

## NotifyMessage

```ts
interface NotifyMeta extends BaseMeta {
  parentId: string
  targetSubName: string
  hitSubName: string
}

interface NotifyMessage extends NACPBaseMessage {
  type: "notify"
  meta: NotifyMeta
  payload: UnknownPayload
}
```

:::warning
`parentId` 是显式订阅的 `subId`。

如果这次Subscribe是由AutoSubscribe构造的，这里的`parentId` 应该是`Request`的 id `reqId`。

`hitSubName` 是实际命中的 EventBus 事件名。
:::

## RegisterMessage

```ts
interface RegisterMeta extends BaseMeta {}

interface RegisterPayload extends BasePayload {
  isGateway: boolean
  decl: Declaration
  record?: boolean
}

interface RegisterMessage extends NACPBaseMessage {
  type: "register"
  meta: RegisterMeta
  payload: RegisterPayload
}
```

## UnregisterMessage

```ts
interface UnregisterMeta extends BaseMeta {}
interface UnregisterPayload extends BasePayload {}

interface UnregisterMessage extends NACPBaseMessage {
  type: "unregister"
  meta: UnregisterMeta
  payload: UnregisterPayload
}
```

## AckMessage

```ts
interface AckMeta extends BaseMeta {
  parentId: string
}

interface AckMessage extends NACPBaseMessage {
  type: "ack"
  meta: AckMeta
  payload?: undefined
}
```

:::tip
`parentId` 指向被确认消息的 `id`。

AckMessage 是唯一不包含 `payload` 字段的消息。
:::

# 类型导入

完整类型可以从 NACP 子路径导入：

```ts
import type {
  NACPMessage,
  RequestMessage,
  ResponseMessage,
} from "@chenyfan/nasdk/NACP"
```
