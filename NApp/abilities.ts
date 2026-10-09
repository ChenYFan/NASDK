import type { NApp } from './NApp.ts'
import type { AbilityProcessorHandler } from './types.ts'
import { HEARTBEAT, type Heartbeat } from './heartbeat.ts'

export const INTRODUCE = 'NApp.introduce'

export function appAbilities(napp: NApp, heartbeat: Heartbeat): AbilityProcessorHandler[] {
  return [
    {
      name: INTRODUCE,
      description: "Return this App's full capability declaration (events + abilities).",
      execute: () => napp.buildDecl(),
    },
    {
      name: HEARTBEAT,
      description: 'Application heartbeat for a direct connection. Payload carries the sender appId.',
      execute: (payload) => {
        const from = (payload as { from?: unknown } | undefined)?.from
        if (typeof from === 'string') heartbeat.onHeartbeatRequest(from)
        return true
      },
    },
  ]
}
