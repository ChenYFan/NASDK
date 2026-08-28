/**
 * NApp types — the item shape for ability registration, and NAppOpts.
 *
 * NACP / NACT hold exactly ONE thing: `this.napp`, the reverse reference to NApp's PUBLIC face. Cross-layer
 * hops are legible at the call site: `this.napp.nact.sendToPeer(...)` outbound, `this.napp.nacp.inbound(...)`
 * inbound.
 */

import type { Declaration, NACPMessage, NotifyMessage, ResponseMessage } from '../NACP/types.ts'
import type { NACTPeerId, Peer, TransportSpec } from '../NACT/types.ts'

/** What `AbilityProcessor.register(item)` takes — pure data plus a callable; `execute` is typically a
 *  closure over the registrar's own refs. */
export interface AbilityProcessorHandler {
  name: string
  description: string
  execute(payload: unknown): unknown | Promise<unknown>
}

/** Declarative shell. Nothing starts until `await app.start()`. */
export interface NAppOpts {
  id: string                        // appId (unique across the network)
  decl?: Declaration                // omitted → aggregated from bound processors
  server?: TransportSpec[]          // entries to expose (empty = client-only App)
  opt?: {
    /** Forward `to≠self` instead of dropping. Declared here only — connect() takes no gateway argument. */
    isGateway?: boolean
    /** Second declaring Gateway: true → keep the link, just not as fallback; false → unregister and drop. */
    autoMultiGatewayDowngrade?: boolean
    /** Link-health threshold for awaiting an ack (NOT a business timeout); expiry marks the appId offline. */
    ackTimeoutMs?: number
    /** How long an offline appId keeps its queued traffic before it is discarded. */
    reconnectGraceMs?: number
    /** Per-queue caps (backlog and ack-pending are mutually exclusive in practice). Byte figure approximate
     *  — see measureBytes. */
    /** Byte cap for NACP outbound backlog and ack-pending queues. */
    queueMaxBytes?: number
    /** Item cap shared by NACP queues and NApp notification streams. */
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
