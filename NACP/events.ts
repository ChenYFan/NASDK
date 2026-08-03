/**
 * NACP event names + payload types, collected here so no string literals scatter through the code.
 *
 * NACP does not own a bus: the communication stack (NApp parent + NACP and NACT children) shares the ONE
 * EventBus instance created with the NApp. NACP only emits and subscribes — no hooks, no state machine.
 * That is the line against NACEB (which news its own bus and offers blocking hooks): here the bus is a
 * read-only observation surface plus the substrate subscriptions actually run on.
 *
 * Four families, on three orthogonal axes plus NACT's own prefix:
 *
 *   nacp:{inbound|outbound}:{type}   a message entered / left NACP     { fromPeerId | toPeerId, msg }
 *   nacp:{event|ability}:{reqId}:…   one CALL's process / terminal     the raw chunk / the result
 *   nacp:internal:{category}:{sub}   internal result or state flow     varies
 *   nact:peer:{action}               physical connection lifecycle     (defined in NACT/events.ts)
 *
 * Two naming rules worth stating, because both were decided against the obvious alternative:
 *
 *  1. inbound/outbound stop at `type` — NO `:{kind}` fourth segment. kind (event/ability/introduce) is a
 *     field inside meta, not a physical dimension; splicing it into the name would make the observation
 *     surface mirror a protocol field. A subscriber reads msg.meta.kind itself.
 *
 *  2. In nacp:event / nacp:ability the reqId sits in the MIDDLE, not at the end. NACP's subject is "which
 *     call is producing this" — reqId is the noun, process/response the verb. So subscribing to everything
 *     one call does is a tail wildcard: `nacp:event:{reqId}:*` (exactly what an auto-subscription uses).
 *     This is the opposite of NACEB's `naceb:{layer}:{state}:{phase}:{id}`, where the id is always last
 *     because THERE the subject is the transition and the id merely says whose. Different subject,
 *     different position — the asymmetry is deliberate.
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

/** The wildcard an auto-subscription subscribes: everything this one call does. */
export function callWildcard(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:*` }
/** The process name for a kind ('ability' never emits process, but the helper keeps callers uniform). */
export function callProcessName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:process` }
/** The terminal name for a kind. */
export function callResponseName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:response` }

// ── fixed internal names ──

export const NACPInternal = {
  nappOnline:  'nacp:internal:napp:online',
  nappOffline: 'nacp:internal:napp:offline',
  routeForwarded: 'nacp:internal:route:forwarded',
  routeDropped:   'nacp:internal:route:dropped',
  // Error names stop at three segments (who), with the concrete cause in payload.reason — an OPEN set, so a
  // new cause never changes a name. "Subscribe to all request errors" is one key; refine on reason inside.
  errorRegister: 'nacp:internal:error:register',   // reason: dual-gateway | version-mismatch | appId-in-use
  errorRequest:  'nacp:internal:error:request',    // reason: no-processor
  errorResponse: 'nacp:internal:error:response',   // reason: has-no-consumer
  errorRoute:    'nacp:internal:error:route',      // reason: unknown
  errorNotify:   'nacp:internal:error:notify',     // reason: has-no-consumer
  errorSubscribe:'nacp:internal:error:subscribe',  // reason: unknown-subscription
} as const

// ── payload shapes (observation only; NACP never reads these to make a decision) ──

export interface InboundPayload  { fromPeerId: NACTPeerId; msg: NACPMessage }
export interface OutboundPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage }

export interface NappOnlinePayload  { appId: string; isGateway: boolean }
export interface NappOfflinePayload { appId: string }
export interface RouteForwardedPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage }
export interface RouteDroppedPayload   { msg: NACPMessage }
export interface ErrorRegisterPayload  { fromPeerId: NACTPeerId; from: string; reason: string }
export interface ErrorMsgPayload       { msg: NACPMessage; reason: string }

/**
 * The `thisArg` NACP passes when emitting a call-entity event. A wildcard subscriber knows the pattern it
 * subscribed but not which concrete name fired; EventBus hands `thisArg` to the listener as its `this`, so
 * the concrete name rides there and the listener can fill NotifyMeta.hitSubName.
 */
export interface EmitContext { hitSubName: string }
