/**
 * NACP public API barrel.
 *
 * Exposes the protocol face (NACP), the message envelope and meta tree consumers read off a message, the
 * declaration types, buildMessage, the event-name builders and constants (the observation surface, and the
 * substrate remote subscriptions actually run on), and the layer error.
 *
 * The three state tables are intentionally not re-exported: they are NACP's own bookkeeping, and reaching
 * them from outside would invite exactly the reverse-index duplication their design rules out.
 */

export { NACP } from './NACP.ts'

export { buildMessage, PROTOCOL_V } from './types.ts'

export type {
  // envelope
  NACPType, ProtocolVersion, NACPBaseMessage, NACPMessage,
  RegisterMessage, UnregisterMessage, SubscribeMessage, UnsubscribeMessage,
  NotifyMessage, RequestMessage, ResponseMessage,
  // meta tree
  BaseMeta, RegisterMeta, UnregisterMeta, RequestMeta, ResponseMeta, NotifyMeta, SubscribeMeta, UnsubscribeMeta,
  // payload: every XxxPayload inherits BasePayload; the response family nests under ResponsePayload.
  // ResponsePayloadUnion is what ResponseMessage.payload actually is (adds UnknownPayload, for a request's answer).
  BasePayload, ResponsePayload, ResponsePayloadUnion, UnknownPayload,
  RegisterPayload, UnregisterPayload, SubscribePayload, UnsubscribePayload,
  RegisterResponsePayload, UnregisterResponsePayload, SubscribeResponsePayload, UnsubscribeResponsePayload,
  RequestKind,
  // declaration (the skeleton NACP defines; concrete names/semantics belong to NAISDK)
  Event, Ability, EventList, AbilitiesList, Declaration,
  // construction
  BuildOpt,
} from './types.ts'

export {
  // directional names (one per type — no kind suffix)
  inboundEvent, outboundEvent,
  // call-entity names: one call's process/terminal stream, reqId in the middle
  eventProcessName, eventResponseName, abilityResponseName,
  callWildcard, callProcessName, callResponseName,
  // fixed internal names
  NACPInternal,
} from './events.ts'

export type {
  InboundPayload, OutboundPayload,
  NappSuccessPayload,
  GatewaySuccessPayload, GatewayErrorPayload, GatewayWarningPayload,
  RegisterErrorPayload, ErrorMsgPayload,
  EmitContext,
} from './events.ts'

export { NACPError, nacpInbound, nacpInternal, nacpOutbound } from './errors.ts'
