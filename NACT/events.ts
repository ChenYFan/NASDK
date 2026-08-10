/**
 * NACT event names + payload types. NACT emits on the shared communication-stack bus (created by the NApp),
 * under its OWN prefix — physical events belong to NACT, not to nacp:*.
 *
 *   nact:peer:{action}   — physical connect / disconnect / error   payload { peerId } (+ reason on error)
 *
 * Physical connect ≠ logical online: nact:peer:connect means bytes can flow, the register handshake has not
 * happened yet (the peer's appId is still unknown). Logical binding is nacp:internal:napp:success.
 *
 * ERROR IS FOLLOWED BY DISCONNECT — the two are not alternatives. `error` says why, `disconnect` says gone.
 * A fault forces the connection down, and a forced drop reaches 'close' → `gone` like any other ending, so
 * the row leaves the table and the departure is announced there. This matters because nact:peer:disconnect is
 * the ONLY trigger for NACP clearing its appId, subscriptions, and waiters: an error that did not end in a
 * disconnect would leave NACP believing a dead peer is still live.
 */

import type { NACTPeerId } from './types.ts'

export const NACTEvent = {
  peerConnect:    'nact:peer:connect',
  peerDisconnect: 'nact:peer:disconnect',
  peerError:      'nact:peer:error',
} as const

/** Reasons carried in nact:peer:error's payload. An OPEN set kept in the payload, never spliced into the
 *  event name — adding a reason must not change the name (so `nact:peer:error` stays one subscribable key). */
export type PeerErrorReason =
  | 'frame-too-large' | 'frame-too-small' | 'decode-failed'
  | 'reassembly-timeout' | 'fragment-out-of-bounds' | 'overlapping-fragment'
  | 'heartbeat-timeout'   // a ping's pong was still outstanding when the next ping came due (ws only; tcp/unix rely on OS keepalive)
  | 'framer-error'
  | (string & {})   // open set

export interface PeerPayload      { peerId: NACTPeerId }
export interface PeerErrorPayload { peerId: NACTPeerId; reason: PeerErrorReason }
