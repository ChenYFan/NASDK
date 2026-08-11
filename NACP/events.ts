/**
 * NACP event names + payload types, collected here so no string literals scatter through the code.
 *
 * NACP does not own a bus, and neither does NACT: the ONE EventBus instance is created with the NApp and all
 * three share it. So `nacp:` is a NAMESPACE, not an instance — it marks which layer DEFINES these names, and
 * only NACP emits them. `nact:` belongs to NACT (see NACT/events.ts), `napp:` to NApp. NACEB and NACAB are
 * external Processors and each news its own bus; that is a different bus entirely.
 *
 * NACP only emits and subscribes — no hooks, no state machine. That is the line against NACEB, which offers
 * blocking hooks: here the bus is a read-only observation surface plus the substrate subscriptions run on.
 *
 * Three families, on three orthogonal axes:
 *
 *   nacp:{inbound|outbound}:{type}      a message entered / left NACP     { fromPeerId | toPeerId, msg }
 *   nacp:{event|ability}:{reqId}:…      one CALL's process / terminal     the raw chunk / the result
 *   nacp:internal:{subject}:{level}     internal flow, level last         always includes reason
 *
 * Three naming rules, each decided against the obvious alternative:
 *
 *  1. inbound/outbound stop at `type` — NO `:{kind}` fourth segment. kind (event/ability) is a
 *     field inside meta, not a physical dimension; splicing it into the name would make the observation
 *     surface mirror a protocol field. A subscriber reads msg.meta.kind itself.
 *
 *  2. In nacp:event / nacp:ability the reqId sits in the MIDDLE, not at the end. NACP's subject is "which
 *     call is producing this" — reqId is the noun, process/response the verb. So subscribing to everything
 *     one call does is a tail wildcard: `nacp:event:{reqId}:*` (what a third-party observer subscribes to;
 *     an auto-subscription instead takes the concrete `:process` name, since the terminal is delivered by
 *     the response message rather than a notify).
 *     This is the opposite of NACEB's `naceb:{layer}:{state}:{phase}:{id}`, where the id is always last
 *     because THERE the subject is the transition and the id merely says whose. Different subject,
 *     different position — the asymmetry is deliberate.
 *
 *  3. In nacp:internal the LEVEL is last and the SUBJECT is third. "Everything about the Gateway" is then a
 *     wildcard (`nacp:internal:gateway:*`) while the level stays a comparable suffix. The exact cause is
 *     never in the name — it is payload.reason, an open set, so adding a cause renames nothing.
 */

import type { NACTPeerId } from '../NACT/types.ts'
import type { NACPMessage, RequestKind } from './types.ts'

// ── directional names: one per type, no kind suffix ──

export function inboundEvent(msg: NACPMessage): string { return `nacp:inbound:${msg.type}` }
export function outboundEvent(msg: NACPMessage): string { return `nacp:outbound:${msg.type}` }

// ── call-entity names: the process/terminal stream of ONE request, reqId in the middle ──

/** `nacp:event:{reqId}:process` — fired for every Processor onProcess chunk. */
export function eventProcessName(reqId: string): string { return `nacp:event:${reqId}:process` }
/** `nacp:event:{reqId}:response` — fired when an event request reaches its terminal. */
export function eventResponseName(reqId: string): string { return `nacp:event:${reqId}:response` }
/** `nacp:ability:{reqId}:response` — an ability's completion. Abilities have no process stream, so this is
 *  the only name in the `nacp:ability:` family. */
export function abilityResponseName(reqId: string): string { return `nacp:ability:${reqId}:response` }

/** Everything one call does, as a tail wildcard — for a third-party observer. An auto-subscription does NOT
 *  use this: it takes the concrete `:process` name, because the terminal reaches the initiator as a response
 *  message rather than a notify. */
export function callWildcard(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:*` }
/** The process name for a kind ('ability' never emits process, but the helper keeps callers uniform). */
export function callProcessName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:process` }
/** The terminal name for a kind. */
export function callResponseName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:response` }

// ── fixed internal names ──

/**
 * Every internal name is `nacp:internal:{subject}:{level}` — subject first, level last, level one of
 * error / warning / log / success. The subject says WHOSE flow this is, the level says how it went; a
 * subscriber that wants "everything about the Gateway" takes `nacp:internal:gateway:*`, one that wants
 * "every failure" takes the level. What EXACTLY happened is never in the name: it is `payload.reason`,
 * an OPEN set, so a new cause never renames an event and never breaks a subscription.
 *
 * `reason` is therefore always a kebab-case identifier a subscriber can compare, never a sentence.
 */
export const NACPInternal = {
  /** An appId↔peer binding changed inside NACP: bound after a register handshake, or dropped on unregister /
   *  disconnect cleanup. `payload.reason` says which. This is the PROTOCOL fact — "this App is now
   *  addressable by appId", not the App-level `napp:remote:online` / `napp:remote:offline`. */
  nappSuccess: 'nacp:internal:napp:success',   // reason: bound | dropped
  /** Gateway flow. success = a foreign packet was forwarded on someone's behalf. error = an inbound packet
   *  was neither ours nor forwardable, so it was dropped. warning = a second peer declared Gateway and lost
   *  the first-come-first-served slot; only fires when autoMultiGatewayDowngrade is on, otherwise the
   *  connection is refused and `registerError` reports `multi-gateway` instead. */
  gatewaySuccess: 'nacp:internal:gateway:success',   // reason: forwarded
  gatewayError:   'nacp:internal:gateway:error',     // reason: dropped
  gatewayWarning: 'nacp:internal:gateway:warning',   // reason: multi-gateway-downgraded
  registerError:  'nacp:internal:register:error',    // reason: dual-gateway | version-mismatch | appId-in-use | multi-gateway | response-timeout | expect-mismatch
  requestError:   'nacp:internal:request:error',     // reason: no-processor
  responseError:  'nacp:internal:response:error',    // reason: has-no-consumer
  routeError:     'nacp:internal:route:error',       // reason: no-route | send-failed | self-addressed
  notifyError:    'nacp:internal:notify:error',      // reason: has-no-consumer
  subscribeError: 'nacp:internal:subscribe:error',   // reason: unknown-subscription | bad-target-sub-name
} as const

// ── payload shapes (observation only; NACP never reads these to make a decision) ──
//
// Every internal payload carries `reason`, because the name stops at the level and the concrete cause lives
// in the payload. The rest of each shape is whatever that subject has to identify itself by.

export interface InboundPayload  { fromPeerId: NACTPeerId; msg: NACPMessage }
export interface OutboundPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage }

/** An appId↔peer binding changed. `isGateway` is meaningful on `bound` only. */
export interface NappSuccessPayload { appId: string; reason: 'bound' | 'dropped'; isGateway?: boolean }
/** A packet was forwarded on someone's behalf. */
export interface GatewaySuccessPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage; reason: string }
/** An inbound packet was neither ours nor forwardable. */
export interface GatewayErrorPayload { msg: NACPMessage; reason: string }
/** The peer that declared Gateway but lost the slot, plus who holds it. */
export interface GatewayWarningPayload { appId: string; peerId: NACTPeerId; keptGatewayPeerId: NACTPeerId | undefined; reason: string }
/** register failed. The appId is not bound at reject time, so the peerId is what identifies the link. */
export interface RegisterErrorPayload { fromPeerId: NACTPeerId; from: string; reason: string }
/** The shape shared by request / response / route / notify / subscribe errors. */
export interface ErrorMsgPayload { msg: NACPMessage; reason: string }

