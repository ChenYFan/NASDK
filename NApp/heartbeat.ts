import type { NApp } from './NApp.ts'
import { NACPInternal } from '../NACP/events.ts'
import type { NappSuccessPayload } from '../NACP/events.ts'
import { nappOutbound } from './errors.ts'

export const HEARTBEAT = 'NApp.heartbeat'
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000

interface HeartbeatState {
  timer?: ReturnType<typeof setTimeout>
  nextTickAt: number
  /** Present only while our request is awaiting its full Response. */
  pendingRequestId?: string
}

export class Heartbeat {
  private states = new Map<string, HeartbeatState>()
  private readonly listenId: string
  private stopped = false

  constructor(private napp: NApp, private readonly intervalMs: number | false) {
    this.listenId = napp.bus.listen(NACPInternal.nappSuccess, ({ appId, reason }: NappSuccessPayload) => {
      this.clearState(appId)
      if (reason === 'bound' && this.intervalMs !== false && !this.stopped) {
        const state: HeartbeatState = { nextTickAt: performance.now() + this.intervalMs / 2 }
        this.states.set(appId, state)
        this.schedule(appId, state, state.nextTickAt)
      }
    })
  }

  /** Dialling side: beat now instead of waiting out the first half interval. */
  start(appId: string) {
    const state = this.states.get(appId)
    if (state && state.pendingRequestId === undefined) this.onTick(appId, state)
  }

  /** A peer's own heartbeat Request is not the Response to ours. */
  onHeartbeatRequest(appId: string) {
    if (this.intervalMs === false || this.stopped) return
    const state = this.states.get(appId)
    if (!state || state.pendingRequestId !== undefined) return
    const nextTickAt = Math.min(state.nextTickAt, performance.now() + this.intervalMs / 2)
    if (nextTickAt < state.nextTickAt) this.schedule(appId, state, nextTickAt)
  }

  stop() {
    this.stopped = true
    this.napp.bus.off(this.listenId)
    for (const appId of this.states.keys()) this.clearState(appId)
  }

  private schedule(appId: string, state: HeartbeatState, nextTickAt: number) {
    clearTimeout(state.timer)
    state.nextTickAt = nextTickAt
    state.timer = setTimeout(() => this.onTick(appId, state), Math.max(0, Math.ceil(nextTickAt - performance.now())))
    state.timer.unref?.()
  }

  private onTick(appId: string, state: HeartbeatState) {
    if (this.stopped || this.states.get(appId) !== state) return
    clearTimeout(state.timer)
    state.timer = undefined
    if (!this.napp.nacp.listOnlineAppId().includes(appId)) return this.clearState(appId)
    if (state.pendingRequestId !== undefined) {
      this.clearState(appId, nappOutbound('heartbeat-timeout', `no heartbeat response from '${appId}'`))
      this.napp.nacp.markOffline(appId)
      return
    }
    this.send(appId, state)
  }

  private send(appId: string, state: HeartbeatState) {
    if (this.intervalMs === false) return
    this.schedule(appId, state, performance.now() + this.intervalMs)
    let requestId = ''
    const response = this.napp.nacp.request(appId, {
      kind: 'ability', target: HEARTBEAT, payload: { from: this.napp.id },
      onReqId: id => { requestId = id; state.pendingRequestId = id },
    })
    const settled = (receivedResponse: boolean) => {
      if (this.states.get(appId) !== state || state.pendingRequestId !== requestId) return
      if (!receivedResponse) return this.clearState(appId)
      state.pendingRequestId = undefined
      // A full Response ends the probe even if its ACK was lost; nothing to replay.
      this.napp.nacp.discardOutbound(requestId)
    }
    // Even an isOk=false Response proves the peer is alive.
    void response.then(() => settled(true), (e: { code?: string }) => settled(e?.code === 'response-not-ok'))
  }

  private clearState(appId: string, reason?: Error) {
    const state = this.states.get(appId)
    if (!state) return
    clearTimeout(state.timer)
    this.states.delete(appId)
    if (state.pendingRequestId !== undefined) this.napp.nacp.discardOutbound(state.pendingRequestId, reason)
  }
}
