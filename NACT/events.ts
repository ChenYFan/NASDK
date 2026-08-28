/**
 * NACT event names + payload types, on the shared NApp bus.
 *
 *   nact:peer:{action}   — physical connect / disconnect / error   payload { peerId } (+ reason on error)
 *
 * Physical connect ≠ logical online (register handshake not yet run). ERROR IS FOLLOWED BY DISCONNECT:
 * `error` says why, `disconnect` says gone — disconnect is the ONLY trigger for NACP cleanup.
 */

import type { NACTPeerId } from './types.ts'

export const NACTEvent = {
  peerConnect:    'nact:peer:connect',
  peerDisconnect: 'nact:peer:disconnect',
  peerError:      'nact:peer:error',
} as const

/** Reasons in nact:peer:error's payload (open set, never spliced into the event name). */
export type PeerErrorReason =
  | 'frame-too-large' | 'frame-too-small' | 'decode-failed'
  | 'reassembly-timeout' | 'fragment-out-of-bounds' | 'overlapping-fragment'
  | 'heartbeat-timeout'   // a ping's pong was still outstanding when the next ping came due (ws only; tcp/unix rely on OS keepalive)
  | 'framer-error'
  | (string & {})   // open set

export interface PeerPayload      { peerId: NACTPeerId }
export interface PeerErrorPayload { peerId: NACTPeerId; reason: PeerErrorReason }
