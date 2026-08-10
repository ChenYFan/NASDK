/**
 * NApp event names — the `napp:` namespace.
 *
 * NApp is an assembly and a doorway, so it has almost nothing to announce: the App-level facts a consumer
 * cares about ("this peer is addressable now", "this connection dropped") already belong to the layer that
 * owns them and are published as `nacp:*` / `nact:*`. Duplicating them here would give the same fact two
 * names.
 *
 * What lands here is only what NApp ITSELF does and no lower layer can see. Today that is one thing: the
 * facade hands out a buffered notify stream (see notifyStream.ts), and a buffer that overflows has dropped
 * data. NACP cannot report it — it delivered the notify to a callback and considers the job done; the drop
 * happens above, in the facade's own queue.
 *
 * Naming follows NACP's rule exactly: `napp:internal:{subject}:{level}`, LEVEL LAST, so "everything about
 * notifies" is `napp:internal:notify:*` and the level stays a comparable suffix. What exactly happened is
 * never in the name — it is `payload.reason`.
 */

/** Fixed internal names, level last. */
export const NAppInternal = {
  /** A subscribe stream's buffer was full, so its OLDEST pending notify was dropped to make room.
   *  reason: `stream-overflow`. Payload: `{ appId, subId, targetSubName, dropped, reason }`.
   *
   *  Warning, not error: the subscription is healthy and still delivering — the CONSUMER is not keeping up
   *  (or never started iterating). Silence here would be indistinguishable from a peer that stopped sending,
   *  which is why the drop is announced rather than swallowed. */
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
