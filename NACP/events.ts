import type { NACTPeerId } from '../NACT/types.ts'
import type { NACPMessage, RequestKind } from './types.ts'

export function inboundEvent(msg: NACPMessage): string { return `nacp:inbound:${msg.type}` }
export function outboundEvent(msg: NACPMessage): string { return `nacp:outbound:${msg.type}` }

export function eventProcessName(reqId: string): string { return `nacp:event:${reqId}:process` }
export function eventResponseName(reqId: string): string { return `nacp:event:${reqId}:response` }
export function eventSignalName(reqId: string): string { return `nacp:event:${reqId}:signal` }
export function abilityResponseName(reqId: string): string { return `nacp:ability:${reqId}:response` }

export function callWildcard(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:*` }
export function callProcessName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:process` }
export function callResponseName(kind: RequestKind, reqId: string): string { return `nacp:${kind}:${reqId}:response` }

export const NACPInternal = {
  nappSuccess:     'nacp:internal:napp:success',
  gatewaySuccess:  'nacp:internal:gateway:success',
  gatewayError:    'nacp:internal:gateway:error',
  gatewayWarning:  'nacp:internal:gateway:warning',
  registerError:   'nacp:internal:register:error',
  requestError:    'nacp:internal:request:error',
  signalError:     'nacp:internal:signal:error',
  responseError:   'nacp:internal:response:error',
  routeError:      'nacp:internal:route:error',
  notifyError:     'nacp:internal:notify:error',
  subscribeError:  'nacp:internal:subscribe:error',
  ackWarning:      'nacp:internal:ack:warning',
  ackError:        'nacp:internal:ack:error',
  backlogWarning:  'nacp:internal:backlog:warning',
} as const

export interface InboundPayload  { fromPeerId: NACTPeerId; msg: NACPMessage }
export interface OutboundPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage }

export interface NappSuccessPayload { appId: string; reason: 'bound' | 'offline' | 'dropped'; isGateway?: boolean }
export interface GatewaySuccessPayload { toPeerId: NACTPeerId | undefined; msg: NACPMessage; reason: string }
export interface GatewayErrorPayload { msg: NACPMessage; reason: string }
export interface GatewayWarningPayload { appId: string; peerId: NACTPeerId; keptGatewayPeerId: NACTPeerId | undefined; reason: string }
export interface RegisterErrorPayload { fromPeerId: NACTPeerId; from: string; reason: string }
export interface ErrorMsgPayload { msg: NACPMessage; reason: string }
