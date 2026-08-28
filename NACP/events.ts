/**
 * NACP event names + payload types. Three families on the shared NApp bus:
 *
 *   nacp:{inbound|outbound}:{type}      a message entered / left NACP
 *   nacp:{event|ability}:{reqId}:…      one CALL's process / terminal (reqId in the middle → tail wildcard)
 *   nacp:internal:{subject}:{level}     internal flow; the exact cause is always payload.reason
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
/** `nacp:event:{reqId}:signal` — fired when an inbound Signal targets this Event request. */
export function eventSignalName(reqId: string): string { return `nacp:event:${reqId}:signal` }
/** `nacp:ability:{reqId}:response` — an ability's completion. Abilities have no process stream, so this is
 *  the only name in the `nacp:ability:` family. */
export function abilityResponseName(reqId: string): string { return `nacp:ability:${reqId}:response` }

/** Everything one call does, as a tail wildcard — for a third-party observer. */
export function callWildcard(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:*` }
export function callProcessName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:process` }
export function callResponseName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:response` }

// ── fixed internal names ──

/** Every internal name is `nacp:internal:{subject}:{level}`; reason is always a kebab-case identifier. */
export const NACPInternal = {
  /** AppId↔peer binding changed: bound / offline / dropped (see NappSuccessPayload). Protocol fact —
   *  distinct from the App-level napp:remote:online / offline. */
  nappSuccess: 'nacp:internal:napp:success',   // reason: bound | offline | dropped
  /** Gateway flow: forwarded / dropped / multi-gateway-downgraded. */
  gatewaySuccess: 'nacp:internal:gateway:success',   // reason: forwarded
  gatewayError:   'nacp:internal:gateway:error',     // reason: dropped
  gatewayWarning: 'nacp:internal:gateway:warning',   // reason: multi-gateway-downgraded
  registerError:  'nacp:internal:register:error',    // reason: dual-gateway | version-mismatch | appId-in-use | multi-gateway | response-timeout | expect-mismatch
  requestError:   'nacp:internal:request:error',     // reason: no-processor
  signalError:    'nacp:internal:signal:error',      // reason: no-event-processor | processor-rejected
  responseError:  'nacp:internal:response:error',    // reason: has-no-consumer
  routeError:     'nacp:internal:route:error',       // reason: no-route | send-failed | self-addressed
  notifyError:    'nacp:internal:notify:error',      // reason: has-no-consumer
  subscribeError: 'nacp:internal:subscribe:error',   // reason: unknown-subscription | bad-target-sub-name
  /** Ack flow: warning = timeout (marks the appId offline) or pending-overflow; error = ack with no holder. */
  ackWarning:     'nacp:internal:ack:warning',       // reason: timeout | pending-overflow
  ackError:       'nacp:internal:ack:error',         // reason: has-no-consumer
  /** Backlog cap losses: notify-dropped | notify-evicted | fifo-evicted. */
  backlogWarning: 'nacp:internal:backlog:warning',   // reason: notify-dropped | notify-evicted | fifo-evicted
} as const

// ── payload shapes (observation only) ──

export interface InboundPayload  { fromPeerId: NACTPeerId; msg: NACPMessage }
export interface OutboundPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage }

export interface NappSuccessPayload { appId: string; reason: 'bound' | 'offline' | 'dropped'; isGateway?: boolean }
export interface GatewaySuccessPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage; reason: string }
export interface GatewayErrorPayload { msg: NACPMessage; reason: string }
export interface GatewayWarningPayload { appId: string; peerId: NACTPeerId; keptGatewayPeerId: NACTPeerId | undefined; reason: string }
export interface RegisterErrorPayload { fromPeerId: NACTPeerId; from: string; reason: string }
/** Shared by request / response / route / notify / subscribe / ack errors and backlog warnings. */
export interface ErrorMsgPayload { msg: NACPMessage; reason: string }
