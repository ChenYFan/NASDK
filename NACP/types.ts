/**
 * NACP types — the message envelope (NACPBaseMessage → 9 message types, discriminated on `type`),
 * the meta inheritance tree, the ability Declaration, and buildMessage (the single source of truth for
 * constructing a NACPMessage).
 *
 * Ownership: the envelope belongs to NACP because NACP DEFINES the protocol format. NACT imports these
 * types (a peer sends/receives whole messages) and NACP imports NACTPeerId back — type-only imports are
 * erased at compile time, so cross-layer type imports are free. Neither imports the other's
 * IMPLEMENTATION; siblings are reached only through `this.napp.{nacp,nact}`, at the call site.
 *
 * Field naming: meta fields are camelCase throughout (parentId / targetSubName / targetSubId), never
 * snake_case. CBOR does not care about case; this is the NASDK internal code style.
 */

// `crypto.randomUUID()` is taken off the GLOBAL Web Crypto, not imported from `node:crypto`: this file is on
// every message-building path, so a Node-only import here would break a browser build of the whole protocol
// layer. globalThis.crypto is standard in browsers (secure contexts) and global in Node ≥19.
// Declaration shapes live at the NASDK root (three layers need them). Imported for use INSIDE this file
// (RegisterMeta.decl, BuildOpt.decl) and re-exported further down, so existing `from './NACP/types.ts'`
// call sites keep resolving.
import type { Declaration } from '../types.ts'

// ============================================================
// Message envelope
// ============================================================

export type NACPType =
  | 'register' | 'unregister' | 'subscribe' | 'unsubscribe'
  | 'notify' | 'request' | 'response' | 'signal' | 'ack'

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
  payload?: any         // the base does NOT take a position on payload; every concrete message declares its own
                        // (normal signal and 7 others carry one; control signal and ack omit it). `any` here so no layer has to invent a
                        // widened view of the envelope just to hand it to an encoder
  meta: BaseMeta        // protocol metadata base; each subclass narrows to a concrete XxxMeta
}

// ── meta tree: BaseMeta → each XxxMeta ──────────────────────────────────────────────────────────────
//
// Where a field lives is decided by WHOSE DATA it is, not field by field:
//
//   INTERNAL family — register / unregister / subscribe / unsubscribe. Pure protocol traffic: nothing outside
//     NACP ever writes or reads it. Their payload is narrowed from `unknown` to a concrete XxxPayload type and
//     carries everything the message has to say, so their meta holds nothing beyond BaseMeta.
//   EXTERNAL family — request / response-to-request / notify. Carries other people's data, so payload stays
//     `unknown` and NACP only moves it whole. What NACP itself needs for these (kind, parentId, the two
//     subscription names) must therefore live in meta, since payload is unreadable to it.
//
// So `meta` is not "where protocol fields go" — it is where protocol fields go WHEN THE PAYLOAD IS OPAQUE.

// ── payload: ONE ROOT, every message type names its own ──────────────────────────────────────────────
//
// Every XxxPayload — including ResponsePayload — inherits BasePayload directly. The ONE nesting is the
// response family: a response's payload varies with WHAT IT ANSWERS, so the four XxxResponsePayload shapes
// inherit ResponsePayload, which is itself just another XxxPayload.
//
//   BasePayload
//   ├─ RegisterPayload / UnregisterPayload / SubscribePayload / UnsubscribePayload
//   │     the destination is NACP ITSELF — these four exist to configure it, so it MUST read them.
//   │     Narrowed to a concrete shape, fully transparent.
//   ├─ UnknownPayload
//   │     the destination is whoever NACP SERVES. request / response-to-request / notify are the reason
//   │     NACP exists: it carries them, it does not consume them. NACP must never touch the contents.
//   └─ ResponsePayload
//      └─ RegisterResponsePayload / UnregisterResponsePayload / SubscribeResponsePayload /
//         UnsubscribeResponsePayload
//
// UnknownPayload is a SIBLING of the readable types, never a child: were it to inherit from one of them, a
// function accepting the readable family would silently accept a notify payload too — losing the one
// distinction this hierarchy exists to express.
//
// Every message type declares its OWN payload type. Never reach for a Base directly: `payload: BasePayload`
// on a concrete message would say "some payload", which is exactly the ambiguity these names remove.

/** Root of the whole hierarchy. Never used directly as a message's payload type. */
export interface BasePayload {}

/** Root of the response family — the payload of a `response`, whatever it answers. Never used directly;
 *  each XxxResponsePayload below names itself. `ResponseMessage.payload` uses ResponsePayloadUnion. */
export interface ResponsePayload extends BasePayload {}

/**
 * The family NACP does NOT read, shared by request / response-to-request / notify. `[k: string]: unknown`
 * keeps it structurally open: anything can travel, and reading a field requires a deliberate cast — which is
 * the point. All NAISDK semantics live in here, invisible to NACP.
 */
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

/** Deliberately empty — register is internal traffic, so everything it says lives in RegisterPayload. */
export interface RegisterMeta extends BaseMeta {}

export interface RequestMeta extends BaseMeta {
  kind: RequestKind
  target?: string   // ability/event full name (e.g. 'qq.send'). buildMessage splits the full name into to + target;
                    // the inbound side reads these two ready-made fields — it never parses strings or prefixes.
}

/**
 * response is the ONE unified terminal/legality signal for register / unregister / subscribe / unsubscribe /
 * request — hence a single ResponseMeta, not one per answered action.
 *
 * `meta` therefore carries ONLY what every response has, or may genuinely have whatever it answers. A field
 * that exists in exactly ONE variant does not belong here: putting it in meta makes the universal envelope
 * describe one special case. Such fields go to the PAYLOAD, in a named per-variant payload type (below).
 */
export interface ResponseMeta extends BaseMeta {
  parentId: string     // = the answered request/subscribe/register/unsubscribe id (narrowed to required)
  isOk: boolean        // PROTOCOL-level ok/fail, readable by NACP itself: register reject, target missing, version mismatch
  whyNotOk?: string    // reason when isOk=false — same layer as isOk (in meta, never in payload)
  kind?: RequestKind   // only when answering a request; echoes that request's kind
}

// ── handshake payloads: the INTERNAL family's real home ─────────────────────────────────────────────────
//
// register / unregister / subscribe / unsubscribe and their four acks are pure protocol traffic, so their
// payload is narrowed from `unknown` to one of these types and NACP reads it directly. request / notify keep
// `unknown` — that is other people's data, and everything under NAISDK lives there.
//
// Some of these are empty today (unregister's response says nothing beyond isOk). They are still named, so a
// future field has an obvious home and the whole family lines up.

/**
 * register. `isGateway` is the forwarding declaration — two `true` peers connecting is rejected
 * (single-Gateway invariant); `decl` is what Events I accept + what Abilities I provide.
 */
export interface RegisterPayload extends BasePayload {
  isGateway: boolean
  decl: Declaration
  record?: boolean         // CBOR record-extension negotiation (reserved; MVP is fixed standard CBOR)
}

/** unregister — "I am leaving" is fully said by the envelope's `from`, so there is nothing to add. */
export interface UnregisterPayload extends BasePayload {}

/** subscribe. Just a name: the subscribable families are told apart by its PREFIX (nacp:event: /
 *  nacp:ability: / nacp:internal: / nact:), so no {kind, ...} struct is needed. May contain a single `*`. */
export interface SubscribePayload extends BasePayload { targetSubName: string }

/** unsubscribe. The id of the subscribe message to cancel — a precise remote `off`. NOT a listenId: that is
 *  the subscribed side's local implementation detail and never leaves it. */
export interface UnsubscribePayload extends BasePayload { targetSubId: string }

/**
 * The payload of the response to a register — the SAME shape as RegisterPayload, and that is the point:
 * register is a symmetric exchange. The dialler sends its own isGateway + decl + record, and gets the peer's
 * back in one round trip, so no follow-up introduce is needed. Both fields belong ONLY to this response,
 * which is exactly why they live here and not in meta.
 *
 * Declared by inheriting BOTH parents rather than restating the fields: `ResponsePayload` is the family
 * membership (this IS a response's payload), `RegisterPayload` is the shape. Copying the fields by hand would
 * hint they might diverge — they must not, since symmetry is what makes the one-round-trip handshake work.
 * `record` rides along for the same reason: CBOR negotiation is each side declaring its own capability, the
 * same pattern as isGateway.
 *
 * NACP reads this payload: `isGateway` is routing input (does this peer become our outbound fallback), and
 * `decl` is the protocol's own declaration structure. That is what makes the handshake family transparent
 * while request/notify payloads stay opaque.
 *
 * Direction is NOT carried by the payload type — both directions are this one shape. It comes from the
 * envelope: a RegisterMessage is the ask, a ResponseMessage is the answer.
 */
export interface RegisterResponsePayload extends ResponsePayload, RegisterPayload {}

/** The payload of the response to an unregister — nothing beyond isOk. */
export interface UnregisterResponsePayload extends ResponsePayload {}

/** The payload of the response to a subscribe. Carries the subId under the SAME name the unsubscribe that
 *  cancels it will use (`UnsubscribePayload.targetSubId`) — the only thing this value is ever for is being
 *  handed back there, so it is not renamed on the way. Equal to `meta.parentId`; stated as a field so that
 *  learning how to cancel does not require knowing NACP's pairing rule. */
export interface SubscribeResponsePayload extends ResponsePayload { targetSubId: string }

/** The payload of the response to an unsubscribe — nothing beyond isOk. */
export interface UnsubscribeResponsePayload extends ResponsePayload {}

/**
 * ack = "the response with this id reached me". Sent by a response's RECEIVER, and only for a response that
 * answers a `request` — the four internal families are protocol traffic whose sender tears its route down
 * immediately, so there is nothing left to confirm to.
 *
 * It confirms ARRIVAL, not business success: a response's own isOk/payload are untouched by it. The response
 * remains the terminal of the original operation; an ack only lets the response's SENDER stop retransmitting.
 *
 * `parentId` (not a `target*` name) because ack is a back-pointing type, which is exactly what BaseMeta's
 * pairing anchor is for. The `target*` names belong to payload fields naming an operand.
 */
export interface AckMeta extends BaseMeta {
  parentId: string   // = the acknowledged Response.id (narrowed to required)
}

export interface SignalMeta extends BaseMeta {
  parentId: string
  kind: SignalKind
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

/** Empty for the same reason as RegisterMeta — see SubscribePayload. */
export interface SubscribeMeta extends BaseMeta {}

/** Empty for the same reason as RegisterMeta — see UnsubscribePayload. */
export interface UnsubscribeMeta extends BaseMeta {}

/** Deliberately empty: "I am leaving" is fully said by the envelope's `from`, so unregister adds no protocol
 *  field of its own. It still gets its own named type rather than reaching for BaseMeta directly, so that all
 *  7 types line up as `XxxMessage.meta: XxxMeta` — and so a future unregister-only field has an obvious home. */
export interface UnregisterMeta extends BaseMeta {}

// ── 9 message types: narrow the `type` literal + BOTH meta and payload ──
//
// Every one names its own meta AND its own payload — no subclass falls back on a Base. A `response` is the one
// type whose payload depends on what it answers, so it takes the union of the four readable shapes plus
// UnknownPayload (when it answers a request). The caller narrows by looking at what it sent. `ack` is the one
// type with NO payload at all: it says nothing except "that response id arrived".

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
// The ONE type with no payload at all: `payload?: undefined` says it may only ever be absent, and
// buildMessage omits the key entirely so nothing rides the wire either.
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

// ============================================================
// Ability declaration — RE-EXPORTED from the NASDK root, not defined here.
//   The shapes moved to ../types.ts because three layers need them (NACP builds a Declaration into the
//   register handshake, NACEB lists events, NACAB lists abilities) and none of the three owns the concept.
//   They are re-exported so `from './NACP/types.ts'` keeps working for the many call sites that already
//   import them from here.
//
//   NACP's own relationship to them is unchanged: it matches on `name` (request.meta.target ↔ some
//   ability.name), never reads `description`, and leaves concrete names/semantics to NAISDK.
// ============================================================

export type { Event, Ability, EventList, AbilitiesList, Declaration } from '../types.ts'

// ============================================================
// buildMessage — the single source of truth for constructing a NACPMessage. Pure, side-effect-free:
//   stamps v/id/t and switches on `type` to assemble the right meta. NACP.build is its only caller
//   (NACT constructs no NACP messages).
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
  payload?: unknown          // ONLY for request / response-to-request / notify. The four internal types build
                             // their payload from the named options above; passing one here is ignored.
}

/**
 * Construct a NACPMessage. `self` = the sender appId (becomes `from`). Stamps v/id/t.
 *
 * Optional fields are SPREAD IN conditionally rather than written as `undefined`. CBOR encodes an explicit
 * undefined as a real key, so writing them unconditionally would put `whyNotOk`/`kind`/`target` on the wire on
 * every message (16 wasted bytes per response) and make `'whyNotOk' in meta` true even on a success. An absent
 * optional field must be absent, not present-and-undefined.
 */
export function buildMessage(self: string, type: NACPType, to: string, opt: BuildOpt = {}): NACPMessage {
  const v = PROTOCOL_V, id = crypto.randomUUID(), from = self, t = Date.now()
  const base = { v, type, id, from, to, t }
  // The three external types: the caller's payload passes through, `{}` when there is none. Always PRESENT —
  // every message has a payload, so an absent one would break the envelope's own contract.
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
    // ack: the one type built WITHOUT a payload key. Not `payload: undefined` — CBOR encodes an explicit
    // undefined as a real field, and an ack carrying a payload slot at all would contradict what it is.
    case 'ack':
      return { ...base, meta: { parentId: opt.parentId! } satisfies AckMeta } as AckMessage
    // The four internal types: meta is empty, everything they say goes in the typed payload. The caller never
    // supplies one for these — we build it from the named options.
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
