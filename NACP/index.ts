/**
 * NACP public API barrel: the protocol face, message envelope/meta/payload types, buildMessage, event-name
 * builders, and the layer error. State tables are NACP-internal and not re-exported.
 */

export { NACP } from './NACP.ts'

export { buildMessage, PROTOCOL_V } from './types.ts'

export type {
  NACPType, ProtocolVersion, NACPBaseMessage, NACPMessage,
  RegisterMessage, UnregisterMessage, SubscribeMessage, UnsubscribeMessage,
  NotifyMessage, RequestMessage, ResponseMessage, SignalMessage, NormalSignalMessage, ControlSignalMessage, AckMessage,
  BaseMeta, RegisterMeta, UnregisterMeta, RequestMeta, ResponseMeta, NotifyMeta, SubscribeMeta, UnsubscribeMeta,
  AckMeta, SignalMeta,
  BasePayload, ResponsePayload, ResponsePayloadUnion, UnknownPayload,
  RegisterPayload, UnregisterPayload, SubscribePayload, UnsubscribePayload,
  RegisterResponsePayload, UnregisterResponsePayload, SubscribeResponsePayload, UnsubscribeResponsePayload,
  RequestKind, SignalKind, SignalOpt,
  Event, Ability, EventList, AbilitiesList, Declaration,
  BuildOpt,
} from './types.ts'

export {
  inboundEvent, outboundEvent,
  eventProcessName, eventResponseName, eventSignalName, abilityResponseName,
  callWildcard, callProcessName, callResponseName,
  NACPInternal,
} from './events.ts'

export type {
  InboundPayload, OutboundPayload,
  NappSuccessPayload,
  GatewaySuccessPayload, GatewayErrorPayload, GatewayWarningPayload,
  RegisterErrorPayload, ErrorMsgPayload,
} from './events.ts'

export { NACPError, nacpInbound, nacpInternal, nacpOutbound } from './errors.ts'
