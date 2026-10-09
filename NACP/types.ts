// randomUUID comes from globalThis, NOT node:crypto — must stay browser-safe.
import type { Declaration } from '../types.ts'

export type NACPType =
  | 'register' | 'unregister' | 'subscribe' | 'unsubscribe'
  | 'notify' | 'request' | 'response' | 'signal' | 'ack'

export interface ProtocolVersion { major: number; minor: number }

export interface NACPBaseMessage {
  v: ProtocolVersion
  type: NACPType
  id: string
  from: string
  to: string
  t: number
  payload?: any
  meta: BaseMeta
}

export interface BasePayload {}

export interface ResponsePayload extends BasePayload {}

export interface UnknownPayload extends BasePayload { [k: string]: unknown }

export interface BaseMeta {
  parentId?: string
}

export type RequestKind = 'event' | 'ability'
export type SignalKind = 'normal' | 'pause' | 'resume' | 'abort'
export type SignalOpt =
  | { parentId: string; kind: 'normal'; payload?: unknown }
  | { parentId: string; kind: 'pause' | 'resume' | 'abort' }

export interface RegisterMeta extends BaseMeta {}

export interface RequestMeta extends BaseMeta {
  kind: RequestKind
  target?: string
}

export interface ResponseMeta extends BaseMeta {
  parentId: string
  isOk: boolean
  whyNotOk?: string
  kind?: RequestKind
}

export interface RegisterPayload extends BasePayload {
  isGateway: boolean
  decl: Declaration
  record?: boolean
}

export interface UnregisterPayload extends BasePayload {}

export interface SubscribePayload extends BasePayload { targetSubName: string }

export interface UnsubscribePayload extends BasePayload { targetSubId: string }

export interface RegisterResponsePayload extends ResponsePayload, RegisterPayload {}

export interface UnregisterResponsePayload extends ResponsePayload {}

export interface SubscribeResponsePayload extends ResponsePayload { targetSubId: string }

export interface UnsubscribeResponsePayload extends ResponsePayload {}

export interface AckMeta extends BaseMeta {
  parentId: string
}

export interface SignalMeta extends BaseMeta {
  parentId: string
  kind: SignalKind
}

export interface NotifyMeta extends BaseMeta {
  parentId: string
  targetSubName: string
  hitSubName: string      // the CONCRETE name that fired (wildcards)
}

export interface SubscribeMeta extends BaseMeta {}

export interface UnsubscribeMeta extends BaseMeta {}

export interface UnregisterMeta extends BaseMeta {}

// ── 9 message types: each narrows the `type` literal + its meta and payload ──

export interface RegisterMessage    extends NACPBaseMessage { type: 'register';    meta: RegisterMeta;    payload: RegisterPayload }
export interface UnregisterMessage  extends NACPBaseMessage { type: 'unregister';  meta: UnregisterMeta;  payload: UnregisterPayload }
export interface SubscribeMessage   extends NACPBaseMessage { type: 'subscribe';   meta: SubscribeMeta;   payload: SubscribePayload }
export interface UnsubscribeMessage extends NACPBaseMessage { type: 'unsubscribe'; meta: UnsubscribeMeta; payload: UnsubscribePayload }
export interface NotifyMessage      extends NACPBaseMessage { type: 'notify';      meta: NotifyMeta;      payload: UnknownPayload }
export interface RequestMessage     extends NACPBaseMessage { type: 'request';     meta: RequestMeta;     payload: UnknownPayload }
export interface ResponseMessage    extends NACPBaseMessage { type: 'response';    meta: ResponseMeta;    payload: ResponsePayloadUnion }
export interface NormalSignalMessage extends NACPBaseMessage {
  type: 'signal'; meta: SignalMeta & { kind: 'normal' }; payload: UnknownPayload
}
export interface ControlSignalMessage extends NACPBaseMessage {
  type: 'signal'; meta: SignalMeta & { kind: 'pause' | 'resume' | 'abort' }; payload?: undefined
}
export type SignalMessage = NormalSignalMessage | ControlSignalMessage
export interface AckMessage         extends NACPBaseMessage { type: 'ack';         meta: AckMeta;         payload?: undefined }

/** What a `response` can carry: the four readable shapes, or business data when it answers a request. */
export type ResponsePayloadUnion =
  | RegisterResponsePayload | UnregisterResponsePayload
  | SubscribeResponsePayload | UnsubscribeResponsePayload
  | UnknownPayload

export type NACPMessage =
  | RegisterMessage | UnregisterMessage | SubscribeMessage | UnsubscribeMessage
  | NotifyMessage | RequestMessage | ResponseMessage | SignalMessage | AckMessage

export type { Event, Ability, EventList, AbilitiesList, Declaration } from '../types.ts'

export const PROTOCOL_V: ProtocolVersion = { major: 2, minor: 1 }

export type BuildOpt = {
  kind?: RequestKind; target?: string
  parentId?: string; isOk?: boolean; whyNotOk?: string
  targetSubName?: string; hitSubName?: string
  targetSubId?: string
  isGateway?: boolean; decl?: Declaration; record?: boolean
  signalKind?: SignalKind
  payload?: unknown          // only for request / response / notify; ignored for internal types
}

// Optional fields are spread conditionally, never explicit undefined — CBOR would encode it as a real key.
export function buildMessage(self: string, type: NACPType, to: string, opt: BuildOpt = {}): NACPMessage {
  const v = PROTOCOL_V, id = crypto.randomUUID(), from = self, t = Date.now()
  const base = { v, type, id, from, to, t }
  const given = (opt.payload ?? {}) as UnknownPayload
  switch (type) {
    case 'request':
      return { ...base, payload: given,
        meta: { kind: opt.kind!, ...(opt.target !== undefined && { target: opt.target }) } } as RequestMessage
    case 'response':
      return { ...base, payload: given,
        meta: {
          parentId: opt.parentId!, isOk: opt.isOk!,
          ...(opt.whyNotOk !== undefined && { whyNotOk: opt.whyNotOk }),
          ...(opt.kind !== undefined && { kind: opt.kind }),
        } } as ResponseMessage
    case 'notify':
      return { ...base, payload: given,
        meta: { parentId: opt.parentId!, targetSubName: opt.targetSubName!, hitSubName: opt.hitSubName! } } as NotifyMessage
    case 'signal':
      if (opt.signalKind === 'normal') {
        return { ...base, payload: given,
          meta: { parentId: opt.parentId!, kind: 'normal' } satisfies SignalMeta } as NormalSignalMessage
      }
      return { ...base,
        meta: { parentId: opt.parentId!, kind: opt.signalKind! } satisfies SignalMeta } as ControlSignalMessage
    case 'ack':
      return { ...base, meta: { parentId: opt.parentId! } satisfies AckMeta } as AckMessage
    case 'register':
      return { ...base, meta: {} satisfies RegisterMeta,
        payload: {
          isGateway: opt.isGateway ?? false,
          decl: opt.decl ?? { events: [], abilities: [] },
          ...(opt.record !== undefined && { record: opt.record }),
        } satisfies RegisterPayload } as RegisterMessage
    case 'unregister':
      return { ...base, meta: {} satisfies UnregisterMeta,
        payload: {} satisfies UnregisterPayload } as UnregisterMessage
    case 'subscribe':
      return { ...base, meta: {} satisfies SubscribeMeta,
        payload: { targetSubName: opt.targetSubName! } satisfies SubscribePayload } as SubscribeMessage
    case 'unsubscribe':
      return { ...base, meta: {} satisfies UnsubscribeMeta,
        payload: { targetSubId: opt.targetSubId! } satisfies UnsubscribePayload } as UnsubscribeMessage
  }
}
