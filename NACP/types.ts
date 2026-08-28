/**
 * NACP types — the message envelope (9 types discriminated on `type`), the meta tree, the payload
 * hierarchy, and buildMessage (the single constructor of NACPMessage).
 */

// NOTE: crypto.randomUUID comes from globalThis (Web Crypto), NOT node:crypto — this file is on every
// message-building path and must stay browser-safe.
import type { Declaration } from '../types.ts'

// ============================================================
// Message envelope
// ============================================================

export type NACPType =
  | 'register' | 'unregister' | 'subscribe' | 'unsubscribe'
  | 'notify' | 'request' | 'response' | 'signal' | 'ack'

/** Same `major` = compatible; `minor` is in-major evolution room. Checked once at register. */
export interface ProtocolVersion { major: number; minor: number }

export interface NACPBaseMessage {
  v: ProtocolVersion
  type: NACPType     // discriminant
  id: string         // uuid, stamped by buildMessage
  from: string       // sender App (end-to-end, never rewritten hop-by-hop)
  to: string         // recipient App (on register: the expected peer appId)
  t: number          // epoch ms
  payload?: any      // every concrete message declares its own payload type
  meta: BaseMeta
}

// meta vs payload — where a field lives follows WHOSE DATA it is:
//   INTERNAL family (register/unregister/subscribe/unsubscribe): pure protocol traffic, NACP reads the
//     typed payload directly; their meta holds nothing beyond BaseMeta.
//   EXTERNAL family (request/response/notify): payload is opaque (`unknown`); what NACP needs for them
//     (kind, parentId, subscription names) lives in meta.

/** Root of the payload hierarchy; every message type names its own concrete payload type. */
export interface BasePayload {}

/** Root of the response family — the four XxxResponsePayload shapes inherit this. */
export interface ResponsePayload extends BasePayload {}

/** The family NACP does NOT read (request / response-to-request / notify); all NAISDK semantics live here. */
export interface UnknownPayload extends BasePayload { [k: string]: unknown }

export interface BaseMeta {
  parentId?: string   // pairing anchor: response/notify point back to their source id; request-likes omit it
}

/** The two kinds that need a bound Processor. Introspection is NOT a kind: it rides `ability` as a
 *  ordinary ability the App registers into its own processor (target 'NApp.introduce'), so the ordinary request
 *  path covers it. */
export type RequestKind = 'event' | 'ability'
export type SignalKind = 'normal' | 'pause' | 'resume' | 'abort'
export type SignalOpt =
  | { parentId: string; kind: 'normal'; payload?: unknown }
  | { parentId: string; kind: 'pause' | 'resume' | 'abort' }

/** Internal family: register is pure protocol traffic — everything it says lives in RegisterPayload. */
export interface RegisterMeta extends BaseMeta {}

export interface RequestMeta extends BaseMeta {
  kind: RequestKind
  target?: string   // ability/event full name (e.g. 'qq.send'); buildMessage splits it into to + target
}

/** The ONE unified terminal/legality signal for all five request-like actions. */
export interface ResponseMeta extends BaseMeta {
  parentId: string     // the answered message id
  isOk: boolean        // PROTOCOL-level ok/fail, readable by NACP itself
  whyNotOk?: string    // reason when isOk=false (stays in meta, never in payload)
  kind?: RequestKind   // only when answering a request
}

/** register: `isGateway` forwarding declaration (two `true` peers = rejected); `decl` = capabilities. */
export interface RegisterPayload extends BasePayload {
  isGateway: boolean
  decl: Declaration
  record?: boolean         // CBOR record-extension negotiation (reserved)
}

export interface UnregisterPayload extends BasePayload {}

/** Just a name; families are told apart by prefix (nacp:event: / nacp:ability: / nacp:internal: / nact:).
 *  May contain a single `*`. */
export interface SubscribePayload extends BasePayload { targetSubName: string }

/** The id of the subscribe message to cancel — NOT the subscribed side's local listenId. */
export interface UnsubscribePayload extends BasePayload { targetSubId: string }

/** Symmetric exchange: the dialler gets the peer's isGateway + decl back in one round trip.
 *  NACP reads this payload (isGateway is routing input). */
export interface RegisterResponsePayload extends ResponsePayload, RegisterPayload {}

export interface UnregisterResponsePayload extends ResponsePayload {}

/** Carries the subId under the SAME name unsubscribe takes (UnsubscribePayload.targetSubId).
 *  Equal to meta.parentId. */
export interface SubscribeResponsePayload extends ResponsePayload { targetSubId: string }

export interface UnsubscribeResponsePayload extends ResponsePayload {}

/**
 * ack = "the message with this id reached me". Confirms ARRIVAL, not business success; it lets the
 * sender stop retransmitting any reliable message.
 */
export interface AckMeta extends BaseMeta {
  parentId: string   // the acknowledged message id
}

export interface SignalMeta extends BaseMeta {
  parentId: string
  kind: SignalKind
}

/** notify = forwarding of one emit on the subscribed side; push, never answered, 0..N per request. */
export interface NotifyMeta extends BaseMeta {
  parentId: string        // the subId (explicit) or reqId (auto-subscription)
  targetSubName: string   // what was subscribed (may contain a single-segment `*`)
  hitSubName: string      // the CONCRETE name that fired — with wildcards, targetSubName alone is ambiguous
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
// The one type with no payload: `payload?: undefined` + buildMessage omits the key entirely.
export interface AckMessage         extends NACPBaseMessage { type: 'ack';         meta: AckMeta;         payload?: undefined }

/** What a `response` can carry: the four readable shapes, or business data when it answers a request. */
export type ResponsePayloadUnion =
  | RegisterResponsePayload | UnregisterResponsePayload
  | SubscribeResponsePayload | UnsubscribeResponsePayload
  | UnknownPayload

/** The outward union — `switch(msg.type)` narrows `msg.meta` to the right XxxMeta with no hand-written casts. */
export type NACPMessage =
  | RegisterMessage | UnregisterMessage | SubscribeMessage | UnsubscribeMessage
  | NotifyMessage | RequestMessage | ResponseMessage | SignalMessage | AckMessage

// Declaration shapes live at the NASDK root (NACP / NACEB / NACAB all need them); re-exported here so
// existing `from './NACP/types.ts'` call sites keep resolving.
export type { Event, Ability, EventList, AbilitiesList, Declaration } from '../types.ts'

// ============================================================
// buildMessage — the single constructor of NACPMessage; stamps v/id/t and assembles meta by `type`.
// ============================================================

export const PROTOCOL_V: ProtocolVersion = { major: 2, minor: 1 }

/** Fields that vary by message type — buildMessage switches on `type` to pick the ones it needs. */
export type BuildOpt = {
  kind?: RequestKind; target?: string                                           // request
  parentId?: string; isOk?: boolean; whyNotOk?: string                          // response (parentId also: notify / ack)
  targetSubName?: string; hitSubName?: string                                   // subscribe + notify
  targetSubId?: string                                                          // unsubscribe
  isGateway?: boolean; decl?: Declaration; record?: boolean                      // register
  signalKind?: SignalKind                                                        // signal
  payload?: unknown          // ONLY for request / response / notify; ignored for the internal types
}

/**
 * Construct a NACPMessage. `self` = the sender appId (becomes `from`). Stamps v/id/t.
 *
 * NOTE: optional fields are SPREAD IN conditionally, never written as explicit undefined — CBOR encodes an
 * explicit undefined as a real key on the wire. Same reason ack has no payload key at all.
 */
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
    // Internal types: meta empty, everything in the typed payload.
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
