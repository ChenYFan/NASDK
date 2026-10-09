import type { Channel, ClientProvider } from '@nyirusu/nasdk/NACT'
import { makeFrameSplitter, NACT_PREFACE } from '@nyirusu/nact-provider-shared'
import { StreamableHTTPChannel, streamableHTTPError } from './channel.ts'

export interface StreamableHTTPClientOptions {
  url: string
  headers?: HeadersInit
  credentials?: RequestCredentials
  fetch?: typeof fetch
  signal?: AbortSignal
  requestTimeoutMs?: number
  maxBufferedBytes?: number
  maxPostBytes?: number
}

export interface StreamableHTTPClientTransportSpec {
  type: 'streamable-http'
  provider: StreamableHTTPClientOptions
  nact?: { chunkSize?: number }
}

export default class StreamableHTTPClientProvider
  implements ClientProvider<'streamable-http', StreamableHTTPClientOptions> {
  readonly type = 'streamable-http'
  readonly role = 'client'
  readonly defaultChunkSize = 64 * 1024

  async dial(options: StreamableHTTPClientOptions): Promise<Channel> {
    const fetcher = options.fetch ?? globalThis.fetch
    const timeout = options.requestTimeoutMs ?? 10_000
    const maxPost = options.maxPostBytes ?? 1024 * 1024
    const maxBuffer = options.maxBufferedBytes ?? 4 * 1024 * 1024
    for (const value of [timeout, maxPost, maxBuffer])
      if (!Number.isSafeInteger(value) || value <= 0) throw streamableHTTPError('invalid-client-limit')

    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.throwIfAborted()
    options.signal?.addEventListener('abort', abort, { once: true })
    const headers = new Headers(options.headers)
    const init = { headers, credentials: options.credentials, cache: 'no-store' as const, redirect: 'error' as const }
    const dialTimer = setTimeout(() => controller.abort(streamableHTTPError('connect-timeout')), timeout)
    let response: Response
    try {
      response = await fetcher(options.url, { ...init, signal: controller.signal })
      if (!response.ok || !response.body || !response.headers.get('x-nact-session')
        || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream') {
        await response.body?.cancel()
        throw streamableHTTPError(`http-connect-${response.status}`)
      }
    } catch (reason) {
      controller.abort()
      options.signal?.removeEventListener('abort', abort)
      throw reason
    } finally {
      clearTimeout(dialTimer)
    }

    headers.set('x-nact-session', response.headers.get('x-nact-session')!)
    headers.set('content-type', 'application/octet-stream')
    const reader = response.body.getReader()
    let sending = Promise.resolve()
    let sendFailed = false
    let queuedBytes = 0
    let prefaceOffset = 0
    const preface = NACT_PREFACE

    const post = async (body?: Uint8Array) => {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)])
      const result = await fetcher(options.url, { ...init, method: 'POST', signal, body: body as BodyInit | undefined })
      await result.body?.cancel()
      if (!result.ok) throw streamableHTTPError(`http-post-${result.status}`)
    }

    let channel!: StreamableHTTPChannel
    const enqueue = (chunks: readonly Uint8Array[]) => {
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      if (queuedBytes + size > maxBuffer) {
        const reason = streamableHTTPError('send-buffer-overflow')
        sendFailed = true
        channel.fail(reason)
        throw reason
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      queuedBytes += size
      const work = sending.then(async () => {
        if (sendFailed) return
        for (let at = 0; at < size; at += maxPost)
          await post(bytes.subarray(at, at + maxPost))
      }).finally(() => { queuedBytes -= size })
      sending = work.catch(reason => { sendFailed = true; channel.fail(reason) })
    }

    channel = new StreamableHTTPChannel({
      send: chunks => enqueue(chunks),
      close: async () => {
        options.signal?.removeEventListener('abort', abort)
        if (!sendFailed) await sending.catch(() => {})
        await reader.cancel().catch(() => {})
        controller.abort()
      },
    }, maxBuffer)
    const push = makeFrameSplitter(frame => channel.receive(frame), reason => channel.fail(reason))

    void (async () => {
      try {
        while (!channel.closed) {
          const { value, done } = await reader.read()
          if (done) {
            if (prefaceOffset < preface.length) throw streamableHTTPError('invalid-http-preface')
            await channel.close()
            break
          }
          let offset = 0
          while (prefaceOffset < preface.length && offset < value.length) {
            if (value[offset++] !== preface[prefaceOffset++]) throw streamableHTTPError('invalid-http-preface')
          }
          push(value.subarray(offset))
        }
      } catch (reason) {
        channel.fail(reason)
      } finally {
        reader.releaseLock()
      }
    })()

    return channel
  }
}
