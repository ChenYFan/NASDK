import type { ClientTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'
import { ByteChannel, transportError } from '@chenyfan/nact-channel'

export interface StreamableHTTPClientOptions {
  url: string
  headers?: HeadersInit
  credentials?: RequestCredentials
  fetch?: typeof fetch
  signal?: AbortSignal
  requestTimeoutMs?: number
  keepAliveMs?: number | false
  maxBufferedBytes?: number
  /** Maximum finite POST size; NACT frames may be split across POSTs. */
  maxPostBytes?: number
}
export interface StreamableHTTPClientTransportSpec {
  type: 'streamable-http'
  provider: StreamableHTTPClientOptions
  nact?: { chunkSize?: number }
}

export default class StreamableHTTPClientProvider
implements ClientTransportProvider<'streamable-http', StreamableHTTPClientOptions> {
  readonly type = 'streamable-http'
  readonly role = 'client'
  readonly defaultChunkSize = 64 * 1024

  async dial(options: StreamableHTTPClientOptions): Promise<TransportChannel> {
    const fetcher = options.fetch ?? globalThis.fetch
    const timeout = options.requestTimeoutMs ?? 10_000
    const maxPost = options.maxPostBytes ?? 1024 * 1024
    const keepAlive = options.keepAliveMs === false ? 0 : options.keepAliveMs ?? 30_000
    const maxBuffer = options.maxBufferedBytes ?? 4 * 1024 * 1024
    for (const value of [timeout, maxPost, maxBuffer])
      if (!Number.isSafeInteger(value) || value <= 0) throw transportError('invalid-client-limit')
    if (!Number.isSafeInteger(keepAlive) || keepAlive < 0) throw transportError('invalid-keepalive')
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.throwIfAborted()
    options.signal?.addEventListener('abort', abort, { once: true })
    const headers = new Headers(options.headers)
    const init = { headers, credentials: options.credentials, cache: 'no-store' as const, redirect: 'error' as const }
    const dialTimer = setTimeout(() => controller.abort(transportError('connect-timeout')), timeout)
    let response: Response
    try {
      response = await fetcher(options.url, { ...init, signal: controller.signal })
      if (!response.ok || !response.body || !response.headers.get('x-nact-session')
        || response.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream') {
        await response.body?.cancel()
        throw transportError(`http-connect-${response.status}`)
      }
    } catch (reason) {
      controller.abort(); options.signal?.removeEventListener('abort', abort); throw reason
    } finally { clearTimeout(dialTimer) }
    headers.set('x-nact-session', response.headers.get('x-nact-session')!)
    headers.set('content-type', 'application/octet-stream')
    const reader = response.body!.getReader()
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let sending = Promise.resolve()
    let queuedBytes = 0
    let heartbeatPending = false
    let prefaceOffset = 0
    const preface = new Uint8Array([78, 65, 67, 84, 1])
    const request = async (method: 'POST' | 'DELETE', body?: Uint8Array) => {
      const timed = AbortSignal.timeout(timeout)
      const signal = method === 'DELETE' ? timed : AbortSignal.any([controller.signal, timed])
      const res = await fetcher(options.url, { ...init, method, signal, body: body as BodyInit | undefined })
      await res.body?.cancel()
      if (!res.ok) throw transportError(`http-${method.toLowerCase()}-${res.status}`)
    }
    const channel = new ByteChannel({
      send: chunks => enqueue(chunks),
      close: async () => {
        clearInterval(heartbeat)
        options.signal?.removeEventListener('abort', abort)
        controller.abort()
        await reader.cancel().catch(() => {})
        // Best effort: cancellation may already have removed the server session.
        await request('DELETE').catch(() => {})
      },
    }, maxBuffer)
    const enqueue = (chunks: readonly Uint8Array[]) => {
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      if (queuedBytes + size > maxBuffer) {
        const reason = transportError('send-buffer-overflow'); channel.fail(reason); return Promise.reject(reason)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      queuedBytes += size
      const work = sending.then(async () => {
        if (channel.closed) throw transportError('transport-closed')
        if (!size) await request('POST', bytes)
        for (let at = 0; at < size; at += maxPost) await request('POST', bytes.subarray(at, at + maxPost))
      }).finally(() => { queuedBytes -= size })
      sending = work.catch(reason => channel.fail(reason))
      return work
    }
    if (keepAlive) heartbeat = setInterval(() => {
      if (heartbeatPending || channel.closed) return
      heartbeatPending = true
      void enqueue([]).catch(() => {}).finally(() => { heartbeatPending = false })
    }, keepAlive)
    void (async () => {
      try {
        while (!channel.closed) {
          const { value, done } = await reader.read()
          if (done) {
            if (prefaceOffset < preface.length) throw transportError('invalid-http-preface')
            await channel.close(); break
          }
          let offset = 0
          while (prefaceOffset < preface.length && offset < value.length)
            if (value[offset++] !== preface[prefaceOffset++]) throw transportError('invalid-http-preface')
          channel.receive(value.subarray(offset))
        }
      } catch (reason) { channel.fail(reason) }
      finally { reader.releaseLock() }
    })()
    return channel
  }
}
