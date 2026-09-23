import type { NACPMessage } from '../NACP/types.ts'
import { makeReassembler, makeStreamParser, splitAndEmit } from './framing.ts'
import type { PeerHost } from './peer.ts'
import type { Peer, TransportChannel } from './types.ts'

function reasonOf(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string') return reason.code
  return 'transport-error'
}

export function makeChannelPeer(host: PeerHost, channel: TransportChannel, chunkSize: number): Peer {
  let sending: Promise<void> | undefined
  const peer: Peer = {
    id: crypto.randomUUID(),
    send: (msg) => {
      const encoded = host.codec.encode(msg)
      splitAndEmit(encoded, chunkSize, (header, body) => {
        const send = () => channel.send([header, body])
        if (sending) {
          sending = sending.then(send).catch(reason => host.fail(peer, reasonOf(reason)))
          return
        }
        try {
          const result = send()
          if (result instanceof Promise) sending = result.catch(reason => host.fail(peer, reasonOf(reason)))
        } catch (reason) {
          host.fail(peer, reasonOf(reason))
        }
      })
    },
    close: () => { void channel.close() },
    terminate: () => { void (channel.terminate?.() ?? channel.close()) },
  }

  const reassembler = makeReassembler(
    (full) => {
      let message: NACPMessage
      try { message = host.codec.decode(full) } catch { return host.fail(peer, 'decode-failed') }
      host.deliver(message, peer)
    },
    reason => host.fail(peer, reason),
  )
  const parse = makeStreamParser(reassembler)

  channel.onReceive((bytes) => {
    try { parse(bytes) } catch (reason) {
      reassembler.clear()
      host.fail(peer, reasonOf(reason))
    }
  })
  channel.onClose(() => { reassembler.clear(); host.gone(peer) })
  channel.onError(reason => host.fail(peer, reasonOf(reason)))

  host.arrived(peer)
  return peer
}
