/**
 * NApp types — the item shape for ability registration, and NAppOpts.
 *
 * ── HOW THE CHILDREN REACH THE PARENT ────────────────────────────────────────────────────────────────
 * Both hold exactly ONE thing: `this.napp`, the reverse reference to NApp's PUBLIC face — id / isGateway /
 * autoMultiGatewayDowngrade / bus / nacp / nact / buildDecl() / getProcessor(). Nothing else, and no
 * private-capability box for either of them.
 *
 * There used to be a `NACPPrivateRef` here, holding one entry (`dispatch(kind)`) because NApp's `processors`
 * map is private. It is gone: the map is still private, but the LOOKUP is now public as
 * `napp.getProcessor(kind)`. Exposing a query is not exposing the table — `bindProcessor` remains the only
 * way in, which matters because that is also where the App registers its own abilities.
 *
 * The result is symmetry. NACP and NACT are peers with identical access to the parent, and every cross-layer
 * hop is legible at the call site: `this.napp.nact.sendToPeer(...)` outbound, `this.napp.nacp.inbound(...)`
 * inbound. A sibling's method was never a box entry anyway — siblings are public.
 *
 * The reverse reference also breaks the construction cycle on its own: NACP stores the NApp reference at
 * construction time but reads `this.napp.nact` only at CALL time, by which point NApp has built it.
 */

import type { Declaration, NACPMessage } from '../NACP/types.ts'
import type { NACTPeerId, Peer, TransportSpec } from '../NACT/types.ts'

/**
 * What `AbilityProcessor.register(item)` takes — PURE DATA plus a callable. Defined here, in NApp, because
 * the App is the party doing the registering: at assembly time NApp registers the abilities it provides on its
 * own behalf (`NApp.introduce`, later `NApp.stat` / `NApp.peers`) through this one port.
 *
 * `execute` receives the payload directly. It is typically a CLOSURE over the registrar's own refs — that is
 * how `NApp.introduce` reaches buildDecl() without the processor learning anything about NApp or NACP. The
 * processor sees a name, a description, and something callable; it cannot tell this apart from an ability a
 * user registered, and it needs no reserved names or privileged tier to handle it.
 */
export interface AbilityProcessorHandler {
  name: string
  description: string
  execute(payload: unknown): unknown | Promise<unknown>
}

/** Declarative shell. Nothing starts until `await app.start()`. */
export interface NAppOpts {
  id: string                        // this App's appId (unique across the network)
  decl?: Declaration                // explicit declaration; omitted → aggregated from bound processors
  server?: TransportSpec[]          // entries to expose (empty = client-only App)
  opt?: {
    /** Behaviour switch, not a topology label: forward `to≠self` instead of dropping. One per network.
     *  Declared here and ONLY here — `connect()` takes no gateway argument. */
    isGateway?: boolean
    /** What to do when a second peer also declares itself a Gateway. The slot is first-come-first-served,
     *  so this decides the loser's fate: true → keep the link, just not as fallback; false (default) →
     *  unregister and drop it. Set true to run as a NAT-style node holding two Gateway links. */
    autoMultiGatewayDowngrade?: boolean
  }
}
