/**
 * NApp types — the parent's view: the two tailored ref boxes it hands to its children, and NAppOpts.
 *
 * The ref-box pattern mirrors NACEB's NACEBPrivateRef: a child never receives the parent wholesale, only a
 * hand-cut box of exactly the capabilities it needs. Three consequences, all deliberate:
 *
 *   1. Capability minimisation — NACT's box has just TWO entries (emit + inbound). It has no business
 *      knowing selfId / isGateway / dispatch / buildDecl, and with a box it cannot reach them.
 *   2. Siblings exchange one METHOD, not an object — NACP gets `sendToPeer`, not the whole NACT; NACT gets
 *      `inbound`, not the whole NACP. Neither can wander into the other's surface.
 *   3. The boxes break the construction cycle: both are built BEFORE the children, and their sibling
 *      entries are thin lambdas that read `this.nacp` / `this.nact` at CALL time, not at construction time.
 *
 * Convention inside the children: internal capabilities always go through `this.ref.*`. What is public on
 * NACP/NACT themselves is the outward surface (inbound/outbound, table queries, listen/dial/sendToPeer).
 */

import type { Processor } from '../types.ts'
import type { Declaration, NACPMessage } from '../NACP/types.ts'
import type { NACTPeerId, Peer, TransportSpec } from '../NACT/types.ts'

/** The box handed to NACP: the parent capabilities it needs + the single outbound face of its sibling NACT. */
export interface NACPPrivateRef {
  readonly selfId: string                                     // this App's appId (becomes `from` when building)
  readonly isGateway: boolean                                 // forwarding switch (to≠self → forward vs drop)
  /** Emit on the shared bus. `thisArg` becomes the listener's `this` — NACP uses it to pass the concrete
   *  fired name so a wildcard subscriber can fill NotifyMeta.hitSubName. */
  emit(name: string, payload?: any, thisArg?: any): void
  listen(name: string, cb: (p: any) => void): string          // subscribe == a local listen on the shared bus
  off(listenId: string): boolean                              // unsubscribe == off
  buildDecl(): Declaration                                    // this App's declaration (register / introduce)
  dispatch(kind: string): Processor | undefined               // the bound Processor for a kind (binding layer)
  sendToPeer(peerId: NACTPeerId, msg: NACPMessage): boolean    // sibling NACT's ONLY outbound face
}

/** The box handed to NACT: just the bus and the single inbound face of its sibling NACP. Nothing else —
 *  NACT reads no protocol semantics, holds no appId, and decides no routing. */
export interface NACTPrivateRef {
  emit(name: string, payload?: any): void                     // emit nact:* on the shared bus
  inbound(msg: NACPMessage, peer: Peer): void                  // sibling NACP's ONLY inbound face
}

/** Declarative shell. Nothing starts until `await app.start()`. */
export interface NAppOpts {
  id: string                        // this App's appId (unique across the network)
  decl?: Declaration                // explicit declaration; omitted → aggregated from bound processors
  server?: TransportSpec[]          // entries to expose (empty = client-only App)
  opt?: { isGateway?: boolean }     // isGateway: behaviour switch, not a topology label. Only one per network.
}
