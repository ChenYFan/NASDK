import type { Declaration, NACPMessage, NotifyMessage, ResponseMessage } from '../NACP/types.ts'
import type { NACTPeerId, Peer, TransportSpec } from '../NACT/types.ts'

export interface AbilityProcessorHandler {
  name: string
  description: string
  execute(payload: unknown): unknown | Promise<unknown>
}

export interface NAppOpts {
  id: string
  decl?: Declaration
  server?: TransportSpec[]
  opt?: {
    isGateway?: boolean
    autoMultiGatewayDowngrade?: boolean
    /** Link-health threshold, NOT a business timeout. */
    ackTimeoutMs?: number
    reconnectGraceMs?: number
    heartbeatIntervalMs?: number | false
    queueMaxBytes?: number
    queueMaxCount?: number
  }
}

export interface AbilityRequestHandle {
  reqId: string
  response: Promise<ResponseMessage>
}

export interface EventRequestHandle extends AbilityRequestHandle {
  stream: AsyncIterable<NotifyMessage>
}

export interface SubscribeHandle {
  subId: string
  response: Promise<ResponseMessage>
  stream: AsyncIterable<NotifyMessage>
}
