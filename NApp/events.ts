/**
 * NApp event names — the `napp:` namespace. Only what NApp itself does lands here (e.g. its own notify
 * stream overflowing, which NACP cannot see). Naming: `napp:internal:{subject}:{level}`, level last.
 */

/** Fixed internal names, level last. */
export const NAppInternal = {
  /** A subscribe stream's buffer overflowed; oldest pending notify dropped (reason: stream-overflow). */
  notifyWarning: 'napp:internal:notify:warning',
} as const

/** Payload of `napp:internal:notify:warning`. */
export interface NotifyWarningPayload {
  /** The peer whose subscription this is. */
  appId: string
  /** The subscription's id — the same one `unsubscribe` takes. */
  subId: string
  /** What was subscribed to (may contain a wildcard). */
  targetSubName: string
  /** The notify payload that was thrown away. */
  dropped: unknown
  reason: 'stream-overflow' | (string & {})
}
