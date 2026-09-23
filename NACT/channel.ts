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
  let ended = false
  let stopping = false
  let closeStarted = false
  let registered = false
  let failureReported = false
  const detach: Array<() => void> = []
  const finish = () => {
    if (ended) return
    ended = true
    reassembler.clear()
    for (const off of detach.splice(0)) off()
    if (registered) host.gone(peer)
  }
  const fail = (reason: unknown) => {
    if (ended || failureReported) return
    failureReported = true
    try { host.fail(peer, reasonOf(reason)) } finally { finish() }
  }
  const close = (force = false) => {
    if (ended || closeStarted || stopping && !force) return
    stopping = true
    const run = () => {
      if (ended || closeStarted) return
      closeStarted = true
      try {
        const result = force && channel.terminate ? channel.terminate() : channel.close()
        void Promise.resolve(result).catch(fail)
      } catch (reason) { fail(reason) }
    }
    // NACP sends its unregister response immediately before closing. Drain accepted writes first.
    if (!force && sending) void sending.then(run)
    else run()
  }
  const peer: Peer = {
    id: crypto.randomUUID(),
    send: (msg) => {
      if (ended || stopping) return
      const encoded = host.codec.encode(msg)
      splitAndEmit(encoded, chunkSize, (header, body) => {
        const send = () => { if (!ended) return channel.send([header, body]) }
        if (sending) {
          sending = sending.then(send).catch(fail)
          return
        }
        try {
          const result = send()
          if (result) sending = Promise.resolve(result).catch(fail)
        } catch (reason) {
          fail(reason)
        }
      })
    },
    close: () => close(),
    terminate: () => close(true),
  }

  const reassembler = makeReassembler(
    (full) => {
      let message: NACPMessage
      try { message = host.codec.decode(full) } catch { return fail('decode-failed') }
      host.deliver(message, peer)
    },
    fail,
  )
  const parse = makeStreamParser(reassembler)

  detach.push(channel.onClose(finish))
  detach.push(channel.onError(fail))
  if (!ended) {
    registered = true
    host.arrived(peer)
  }
  if (!ended) detach.push(channel.onReceive((bytes) => {
    if (ended) return
    try { parse(bytes) } catch (reason) {
      reassembler.clear()
      fail(reason)
    }
  }))
  if (ended) for (const off of detach.splice(0)) off()
  return peer
}
