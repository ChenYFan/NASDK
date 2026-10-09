import type { NACPMessage } from '../NACP/types.ts'
import { errorDetail } from '../types.ts'
import { NACTError, codeOf, nactOutbound } from './errors.ts'
import { makeFrameReceiver, splitAndEmit } from './framing.ts'
import type { PeerHost } from './peer.ts'
import type { Channel, Peer } from './types.ts'

const reasonOf = (reason: unknown) => codeOf(reason, 'transport-error')

export function makeChannelPeer(host: PeerHost, channel: Channel, chunkSize: number): Peer {
  let sending = Promise.resolve()
  let failure: NACTError | undefined
  const pending = new Set<(reason: NACTError) => void>()
  const stop = (reason: NACTError) => {
    failure ??= reason
    for (const reject of pending) reject(failure)
    pending.clear()
  }
  const fail = (reason: unknown) => {
    if (failure) return
    stop(nactOutbound(reasonOf(reason), `Provider failed: ${errorDetail(reason)}`, reason))
    host.fail(peer, reasonOf(reason))
  }
  const closed = () => stop(nactOutbound('transport-closed', 'Provider closed before accepting all frames'))
  const peer: Peer = {
    id: crypto.randomUUID(),
    send: async (msg) => {
      if (failure) throw failure
      let encoded: Uint8Array
      try { encoded = host.codec.encode(msg) } catch (reason) {
        throw nactOutbound('encode-failed', `cannot encode ${msg.type} message: ${errorDetail(reason)}`, reason)
      }
      const frames: (readonly Uint8Array[])[] = []
      splitAndEmit(encoded, chunkSize, (header, body) => frames.push([header, body]))
      return new Promise<void>((resolve, reject) => {
        pending.add(reject)
        const work = sending.then(async () => {
          for (const frame of frames) {
            if (failure) throw failure
            await channel.send(frame)
          }
        })
        sending = work.then(() => {
          pending.delete(reject)
          resolve()
        }, fail)
      })
    },
    close: () => { closed(); void channel.close() },
    terminate: () => { closed(); void (channel.terminate?.() ?? channel.close()) },
  }

  let broken = false
  const receiver = makeFrameReceiver(
    (full) => {
      let message: NACPMessage
      try { message = host.codec.decode(full) } catch { return host.fail(peer, 'decode-failed') }
      host.deliver(message, peer)
    },
    reason => host.fail(peer, reason),
  )

  channel.onReceive((frame) => {
    if (broken) return
    try { receiver.receive(frame) } catch (reason) {
      broken = true
      receiver.clear()
      host.fail(peer, reasonOf(reason))
    }
  })
  channel.onClose(() => { closed(); receiver.clear(); host.gone(peer) })
  channel.onError(fail)

  host.arrived(peer)
  return peer
}
