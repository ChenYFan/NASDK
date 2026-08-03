/**
 * NACP types — the message envelope (NACPBaseMessage → 7 full-name subclasses, discriminated on `type`),
 * the meta inheritance tree, the ability Declaration, and buildMessage (the single source of truth for
 * constructing a NACPMessage).
 *
 * Ownership: the envelope belongs to NACP because NACP DEFINES the protocol format. NACT imports these
 * types (a peer sends/receives whole messages) and NACP imports NACTPeerId back — type-only imports are
 * erased at compile time, so cross-layer type imports are free. Neither imports the other's
 * IMPLEMENTATION; sibling implementations are reached only via the one method each ref box exposes.
 *
 * Field naming: meta fields are camelCase throughout (parentId / targetSubName / targetSubId), never
 * snake_case. CBOR does not care about case; this is the NASDK internal code style.
 */

import { randomUUID } from 'node:crypto'

// ============================================================
// Message envelope
// ============================================================

export type NACPType =
  | 'register' | 'unregister' | 'subscribe' | 'unsubscribe'
  | 'notify' | 'request' | 'response'

/** Protocol version. Same `major` = compatible; cross-`major` = incompatible. `minor` is in-major
 *  evolution room. Checked ONCE at register (cross-major → reject); other messages carry it without
 *  per-message validation (carrying it everywhere is for cross-language/debug self-description).
 *  NOT a float — that was a design bug: 1.10 < 1.9 numerically, precision noise, minor isn't a fraction. */
export interface ProtocolVersion { major: number; minor: number }

/** Every NACP message shares these envelope main fields (the message-body base class). */
export interface NACPBaseMessage {
  v: ProtocolVersion // protocol version {major, minor}
  type: NACPType     // discriminant
  id: string         // uuid, stamped by buildMessage
  from: string       // sender App (end-to-end, never rewritten hop-by-hop)
  to: string         // recipient App (on register: the expected peer appId)
  t: number          // epoch ms, stamped by buildMessage
  payload?: unknown  // business load — opaque AND unreadable here: NACP only ever moves it whole
  meta: BaseMeta     // protocol metadata base; each subclass narrows to a concrete XxxMeta
}

// ── meta tree: BaseMeta → each XxxMeta. NACP reads meta; payload stays opaque. ──

export interface BaseMeta {
  parentId?: string   // pairing anchor: response/notify point back to their source id; request-likes omit it
}

export type RequestKind = 'event' | 'ability' | 'introduce'

export interface RegisterMeta extends BaseMeta {
  isGateway: boolean       // forwarding identity; two `true` peers connecting → rejected (single-Gateway invariant)
  decl: Declaration        // what Events I accept + what Abilities I provide
  record?: boolean         // CBOR record-extension negotiation (reserved; MVP is fixed standard CBOR)
}

export interface RequestMeta extends BaseMeta {
  kind: RequestKind
  target?: string   // ability/event full name (e.g. 'qq.send'). buildMessage splits the full name into to + target;
                    // the inbound side reads these two ready-made fields — it never parses strings or prefixes.
                    // `introduce` needs no target (it asks for the whole declaration, not one item).
}

/** response is the ONE unified terminal/legality signal for register / subscribe / unsubscribe / request —
 *  hence a single ResponseMeta, not one per answered action. */
export interface ResponseMeta extends BaseMeta {
  parentId: string     // = the answered request/subscribe/register/unsubscribe id (narrowed to required)
  isOk: boolean        // PROTOCOL-level ok/fail, readable by NACP itself: register reject, target missing, version mismatch
  whyNotOk?: string    // reason when isOk=false — same layer as isOk (in meta, never in payload)
  kind?: RequestKind   // only when answering a request; echoes that request's kind
  decl?: Declaration   // register-accept + introduce-response carry the peer's full declaration
  isGateway?: boolean  // register-accept only: mirrors RegisterMeta.isGateway so the client learns the peer is a Gateway
}

/** notify = the forwarding of one emit on the subscribed side. Push, never answered, 0..N of them.
 *  It is NOT the terminal signal — the terminal is always that one unique response. */
export interface NotifyMeta extends BaseMeta {
  parentId: string        // required: the subId (explicit subscription) or reqId (auto-subscription)
  targetSubName: string   // the SOURCE subscription name — what was subscribed (may contain a single-segment `*`)
  hitSubName: string      // the CONCRETE name that fired (no wildcard)
  // Why both: a subscriber subscribes with a wildcard (e.g. 'nacp:event:{reqId}:*'), so targetSubName alone
  // cannot tell whether ':process' or ':response' fired. Locally an EventBus listener implicitly knows both
  // (its pattern, and the emitted key); across a process boundary that is lost, so both are put in meta.
}

export interface SubscribeMeta extends BaseMeta {
  targetSubName: string   // the event name to subscribe on the peer's NApp EventBus (may contain single-segment `*`).
                          // Just a name — the three subscribable families are distinguished by its PREFIX
                          // (nacp:event: / nacp:ability: / nacp:internal: / nact:), so no {kind, ...} struct is needed.
}

export interface UnsubscribeMeta extends BaseMeta {
  targetSubId: string     // the id of the subscribe message to cancel (precise unsubscribe == a remote `off`)
}

// ── 7 full-name subclasses: narrow the `type` literal + the corresponding meta ──

export interface RegisterMessage    extends NACPBaseMessage { type: 'register';    meta: RegisterMeta }
export interface UnregisterMessage  extends NACPBaseMessage { type: 'unregister';  meta: BaseMeta }
export interface SubscribeMessage   extends NACPBaseMessage { type: 'subscribe';   meta: SubscribeMeta }
export interface UnsubscribeMessage extends NACPBaseMessage { type: 'unsubscribe'; meta: UnsubscribeMeta }
export interface NotifyMessage      extends NACPBaseMessage { type: 'notify';      meta: NotifyMeta }
export interface RequestMessage     extends NACPBaseMessage { type: 'request';     meta: RequestMeta }
export interface ResponseMessage    extends NACPBaseMessage { type: 'response';    meta: ResponseMeta }

/** The outward union — `switch(msg.type)` narrows `msg.meta` to the right XxxMeta with no hand-written casts. */
export type NACPMessage =
  | RegisterMessage | UnregisterMessage | SubscribeMessage | UnsubscribeMessage
  | NotifyMessage | RequestMessage | ResponseMessage

// ============================================================
// Ability declaration — NACP defines the SKELETON (name + description); concrete names/semantics are NAISDK's.
//   NACP matches on `name` (request.meta.target ↔ some ability.name) and never reads `description`.
//   "No abilities" = an empty list; no explicit marker needed. Same for "accepts no events".
// ============================================================

export interface Event   { name: string; description: string }
export interface Ability { name: string; description: string }
export type EventList     = Event[]
export type AbilitiesList = Ability[]

/** One full declaration. register (RegisterMeta.decl) and introduce-response (ResponseMeta.decl) carry the
 *  SAME thing — two moments of taking the same declaration, so one shared type. */
export interface Declaration { events: EventList; abilities: AbilitiesList }

// ============================================================
// buildMessage — the single source of truth for constructing a NACPMessage. Pure, side-effect-free:
//   stamps v/id/t and switches on `type` to assemble the right meta. NACP.build is its only caller
//   (NACT constructs no NACP messages).
// ============================================================

export const PROTOCOL_V: ProtocolVersion = { major: 1, minor: 0 }

/** Fields that vary by message type — buildMessage switches on `type` to pick the ones it needs. */
export type BuildOpt = {
  kind?: RequestKind; target?: string                                           // request
  parentId?: string; isOk?: boolean; whyNotOk?: string; decl?: Declaration      // response
  targetSubName?: string; hitSubName?: string                                   // subscribe + notify
  targetSubId?: string                                                          // unsubscribe
  isGateway?: boolean                                                           // register + register-accept response
  payload?: unknown                                                             // opaque, moved whole
}

/** Construct a NACPMessage. `self` = the sender appId (becomes `from`). Stamps v/id/t. */
export function buildMessage(self: string, type: NACPType, to: string, opt: BuildOpt = {}): NACPMessage {
  const v = PROTOCOL_V, id = randomUUID(), from = self, t = Date.now(), payload = opt.payload
  switch (type) {
    case 'request':
      return { v, type, id, from, to, t, payload,
        meta: { kind: opt.kind!, target: opt.target } } as RequestMessage
    case 'response':
      return { v, type, id, from, to, t, payload,
        meta: { parentId: opt.parentId!, isOk: opt.isOk!, whyNotOk: opt.whyNotOk, kind: opt.kind, decl: opt.decl, isGateway: opt.isGateway } } as ResponseMessage
    case 'notify':
      return { v, type, id, from, to, t, payload,
        meta: { parentId: opt.parentId!, targetSubName: opt.targetSubName!, hitSubName: opt.hitSubName! } } as NotifyMessage
    case 'register':
      return { v, type, id, from, to, t, payload,
        meta: { isGateway: opt.isGateway ?? false, decl: opt.decl ?? { events: [], abilities: [] } } } as RegisterMessage
    case 'unregister':
      return { v, type, id, from, to, t, payload, meta: {} } as UnregisterMessage
    case 'subscribe':
      return { v, type, id, from, to, t, payload,
        meta: { targetSubName: opt.targetSubName! } } as SubscribeMessage
    case 'unsubscribe':
      return { v, type, id, from, to, t, payload,
        meta: { targetSubId: opt.targetSubId! } } as UnsubscribeMessage
  }
}
