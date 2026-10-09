export const NAppInternal = {
  notifyWarning: 'napp:internal:notify:warning',
} as const

export interface NotifyWarningPayload {
  appId: string
  subId: string
  targetSubName: string
  dropped: unknown
  reason: 'stream-overflow' | (string & {})
}
