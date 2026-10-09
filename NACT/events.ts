// Physical connect ≠ logical online; disconnect, not error, is the only NACP cleanup trigger.

import type { NACTPeerId } from './types.ts'

export const NACTEvent = {
  peerConnect:    'nact:peer:connect',
  peerDisconnect: 'nact:peer:disconnect',
  peerError:      'nact:peer:error',
} as const

export type PeerErrorReason =
  | 'frame-too-small' | 'frame-too-large' | 'frame-size-mismatch' | 'version-mismatch' | 'bad-magic'
  | 'frame-out-of-bounds' | 'overlapping-frame' | 'reassembly-timeout' | 'decode-failed'
  | 'transport-error'
  | (string & {})

export interface PeerPayload      { peerId: NACTPeerId }
export interface PeerErrorPayload { peerId: NACTPeerId; reason: PeerErrorReason }
