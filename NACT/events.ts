/**
 * NACT event names + payload types. NACT emits on the shared communication-stack bus (created by the NApp),
 * under its OWN prefix — physical events belong to NACT, not to nacp:*.
 *
 *   nact:peer:{action}   — physical connect / disconnect / error   payload { peerId } (+ reason on error)
 *
 * Physical connect ≠ logical online: nact:peer:connect means bytes can flow, the register handshake has not
 * happened yet (the peer's appId is still unknown). Logical online is nacp:internal:napp:online.
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
  | 'framer-error'
  | (string & {})   // open set

export interface PeerPayload      { peerId: NACTPeerId }
export interface PeerErrorPayload { peerId: NACTPeerId; reason: PeerErrorReason }
