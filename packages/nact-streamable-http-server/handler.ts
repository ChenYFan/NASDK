import type { Channel, ServerProvider, ServerHandle } from '@nyirusu/nasdk/NACT'
import { makeFrameSplitter, NACT_PREFACE } from '@nyirusu/nact-provider-shared'
import { StreamableHTTPChannel, streamableHTTPError } from './channel.ts'

export const SESSION_HEADER = 'x-nact-session'

export type StreamableHTTPServerOptions = {
  authorize?: (request: Request) => boolean | Promise<boolean>
  maxSessions?: number
  maxBodyBytes?: number
  maxBufferedBytes?: number
  idleTimeoutMs?: number
} & ({ noServer?: false; host?: string; port: number; path?: string } | { noServer: true; host?: never; port?: never; path?: never })

export interface StreamableHTTPServerTransportSpec {
  type: 'streamable-http'
  provider: StreamableHTTPServerOptions
  nact?: { chunkSize?: number }
}

interface ServerConfig {
  path?: string
  authorize?: (request: Request) => boolean | Promise<boolean>
  maxSessions: number
  maxBodyBytes: number
  maxBufferedBytes: number
  idleTimeoutMs: number
}

interface Session {
  channel: StreamableHTTPChannel
  push(chunk: Uint8Array): void
  writing: boolean
  touch(): void
}

// Request → Response protocol core, shared by standalone and attached servers.
export default class StreamableHTTPCore
  implements ServerProvider<'streamable-http', StreamableHTTPServerOptions> {
  readonly type = 'streamable-http'
  readonly role = 'server'
  readonly defaultChunkSize = 64 * 1024
  private accept?: (channel: Channel) => void
  private options?: ServerConfig
  private sessions = new Map<string, Session>()

  async listen(options: StreamableHTTPServerOptions, accept: (channel: Channel) => void): Promise<ServerHandle> {
    if (this.accept) throw streamableHTTPError('provider-already-listening')
    const config: ServerConfig = {
      path: options.noServer ? undefined : options.path ?? '/nacp',
      authorize: options.authorize,
      maxSessions: options.maxSessions ?? 1024,
      maxBodyBytes: options.maxBodyBytes ?? 4 * 1024 * 1024,
      maxBufferedBytes: options.maxBufferedBytes ?? 4 * 1024 * 1024,
      idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
    }
    for (const key of ['maxSessions', 'maxBodyBytes', 'maxBufferedBytes', 'idleTimeoutMs'] as const) {
      const minimum = key === 'idleTimeoutMs' ? 0 : key === 'maxBufferedBytes' ? 5 : 1
      if (!Number.isSafeInteger(config[key]) || config[key] < minimum)
        throw streamableHTTPError(`invalid-${key}`)
    }
    this.options = config
    this.accept = accept
    let closed = false
    return {
      close: async () => {
        if (closed) return
        closed = true
        this.accept = undefined
        this.options = undefined
        for (const session of this.sessions.values()) await session.channel.close()
      },
    }
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const options = this.options
    if (!this.accept || !options) return new Response(null, { status: 503 })
    if (options.path && new URL(request.url).pathname !== options.path) return new Response(null, { status: 404 })
    if (!['GET', 'POST'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } })
    if (options.authorize && !await options.authorize(request))
      return new Response(null, { status: 403 })
    if (!this.accept) return new Response(null, { status: 503 })
    if (request.signal.aborted) return new Response(null, { status: 400 })
    if (request.method === 'GET') return this.open(request, options)

    const session = this.sessions.get(request.headers.get(SESSION_HEADER) ?? '')
    if (!session) return new Response(null, { status: 404 })
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream')
      return new Response(null, { status: 415 })
    if (session.writing) return new Response(null, { status: 409 })

    session.writing = true
    const reader = request.body?.getReader()
    const abort = () => session.channel.fail(streamableHTTPError('upload-aborted'))
    request.signal.addEventListener('abort', abort, { once: true })
    let total = 0
    try {
      while (reader) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > options.maxBodyBytes) {
          await reader.cancel()
          session.channel.fail(streamableHTTPError('body-too-large'))
          return new Response(null, { status: 413 })
        }
        // Drain finite POST bodies after session close. Cancelling a host-owned
        // Request stream can race its pending end event (Next/Undici and H3).
        if (!session.channel.closed) session.push(value)
      }
      return new Response(null, { status: 204 })
    } catch (reason) {
      session.channel.fail(reason)
      return new Response(null, { status: 400 })
    } finally {
      request.signal.removeEventListener('abort', abort)
      reader?.releaseLock()
      session.writing = false
      session.touch()
    }
  }

  private open(request: Request, options: ServerConfig): Response {
    if (this.sessions.size >= options.maxSessions) return new Response(null, { status: 503 })
    const token = crypto.randomUUID()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let timer: ReturnType<typeof setTimeout> | undefined
    let ended = false

    const cleanup = () => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
      this.sessions.delete(token)
      try { controller.close() } catch { /* response already cancelled */ }
    }
    const touch = () => {
      clearTimeout(timer)
      if (options.idleTimeoutMs && !ended) timer = setTimeout(abort, options.idleTimeoutMs)
    }
    const channel = new StreamableHTTPChannel({
      send: chunks => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        if (size > (controller.desiredSize ?? 0)) {
          const reason = streamableHTTPError('send-buffer-overflow')
          channel.fail(reason)
          throw reason
        }
        for (const chunk of chunks) controller.enqueue(chunk.slice())
        touch()
      },
      close: cleanup,
    }, options.maxBufferedBytes)
    const abort = () => { void channel.close() }
    const body = new ReadableStream<Uint8Array>({
      start: value => {
        controller = value
        controller.enqueue(new Uint8Array(NACT_PREFACE))
      },
      cancel: () => { void channel.close() },
    }, { highWaterMark: options.maxBufferedBytes, size: bytes => bytes.byteLength })

    const push = makeFrameSplitter(frame => channel.receive(frame), reason => channel.fail(reason))
    this.sessions.set(token, { channel, push, writing: false, touch })
    request.signal.addEventListener('abort', abort, { once: true })
    touch()
    try {
      this.accept!(channel)
    } catch (reason) {
      channel.fail(reason)
      return new Response(null, { status: 500 })
    }
    return new Response(body, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        [SESSION_HEADER]: token,
      },
    })
  }
}
