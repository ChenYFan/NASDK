import type { ServerHandle, ServerTransportProvider, TransportChannel } from '@chenyfan/nasdk/NACT'
import { ByteChannel, transportError } from '@chenyfan/nact-channel'

export const SESSION_HEADER = 'x-nact-session'
export interface StreamableHTTPServerOptions {
  /** Called for every request, before allocating or accessing a session. */
  authorize?: (request: Request) => boolean | Promise<boolean>
  maxSessions?: number
  maxBodyBytes?: number
  maxBufferedBytes?: number
  /** Inactivity expiry; 0 disables it. Clients keep idle sessions alive with empty POSTs. */
  idleTimeoutMs?: number
}
export interface StreamableHTTPServerTransportSpec {
  type: 'streamable-http'
  provider: StreamableHTTPServerOptions
  nact?: { chunkSize?: number }
}
interface Session {
  channel: ByteChannel
  writing: boolean
  touch(): void
}

/** Host-managed HTTP listener: mount handle() in an existing Fetch-compatible router. */
export default class StreamableHTTPServerProvider
implements ServerTransportProvider<'streamable-http', StreamableHTTPServerOptions> {
  readonly type = 'streamable-http'
  readonly role = 'server'
  readonly defaultChunkSize = 64 * 1024
  private accept?: (channel: TransportChannel) => void
  private options!: Required<Omit<StreamableHTTPServerOptions, 'authorize'>> & Pick<StreamableHTTPServerOptions, 'authorize'>
  private sessions = new Map<string, Session>()
  get sessionCount() { return this.sessions.size }

  async listen(options: StreamableHTTPServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    if (this.accept) throw transportError('provider-already-listening')
    const config = { maxSessions: 1024, maxBodyBytes: 4 * 1024 * 1024,
      maxBufferedBytes: 4 * 1024 * 1024, idleTimeoutMs: 120_000, ...options }
    for (const key of ['maxSessions', 'maxBodyBytes', 'maxBufferedBytes', 'idleTimeoutMs'] as const)
      if (!Number.isSafeInteger(config[key]) || config[key] < (key === 'idleTimeoutMs' ? 0 : key === 'maxBufferedBytes' ? 5 : 1))
        throw transportError(`invalid-${key}`)
    this.options = config
    this.accept = accept
    let closed = false
    return { close: async () => {
      if (closed) return
      closed = true
      this.accept = undefined
      for (const session of this.sessions.values()) await session.channel.close()
    } }
  }

  readonly handle = async (request: Request): Promise<Response> => {
    if (!this.accept) return new Response(null, { status: 503 })
    if (!['GET', 'POST', 'DELETE'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, POST, DELETE' } })
    if (this.options.authorize && !await this.options.authorize(request))
      return new Response(null, { status: 403 })
    // Authorization may yield while the host is shutting down.
    if (!this.accept) return new Response(null, { status: 503 })
    if (request.signal.aborted) return new Response(null, { status: 400 })
    if (request.method === 'GET') return this.open(request)
    const session = this.sessions.get(request.headers.get(SESSION_HEADER) ?? '')
    if (!session) return new Response(null, { status: 404 })
    if (request.method === 'DELETE') {
      await session.channel.close()
      return new Response(null, { status: 204 })
    }
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/octet-stream')
      return new Response(null, { status: 415 })
    // Concurrent POSTs can reorder fragments; reject instead of silently corrupting the stream.
    if (session.writing) return new Response(null, { status: 409 })
    session.writing = true
    const reader = request.body?.getReader()
    const cancelUpload = () => { void reader?.cancel().catch(() => {}) }
    const offClose = session.channel.onClose(cancelUpload)
    const abort = () => session.channel.fail(transportError('upload-aborted'))
    request.signal.addEventListener('abort', abort, { once: true })
    let total = 0
    try {
      const parts: Uint8Array[] = []
      while (reader) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > this.options.maxBodyBytes) {
          await reader.cancel(); session.channel.fail(transportError('body-too-large'))
          return new Response(null, { status: 413 })
        }
        parts.push(value)
      }
      if (session.channel.closed) return new Response(null, { status: 404 })
      for (const part of parts) session.channel.receive(part)
      session.touch()
      return new Response(null, { status: session.channel.closed ? 400 : 204 })
    } catch (reason) {
      session.channel.fail(reason)
      return new Response(null, { status: 400 })
    } finally {
      offClose(); request.signal.removeEventListener('abort', abort)
      reader?.releaseLock(); session.writing = false
    }
  }

  private open(request: Request): Response {
    if (this.sessions.size >= this.options.maxSessions) return new Response(null, { status: 503 })
    const token = crypto.randomUUID()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
      this.sessions.delete(token)
      try { controller.close() } catch { /* consumer already cancelled */ }
    }
    const channel = new ByteChannel({
      send: chunks => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        if (size > (controller.desiredSize ?? 0)) {
          const error = transportError('send-buffer-overflow')
          channel.fail(error); throw error
        }
        for (const chunk of chunks) controller.enqueue(chunk.slice())
        touch()
      },
      close: cleanup,
    }, this.options.maxBodyBytes)
    const abort = () => { void channel.close() }
    const touch = () => {
      clearTimeout(timer)
      if (this.options.idleTimeoutMs && !closed)
        timer = setTimeout(abort, this.options.idleTimeoutMs)
    }
    const body = new ReadableStream<Uint8Array>({
      // Transport preface forces hosts to flush headers before NACP register arrives.
      // It is consumed by the HTTP client, never passed to NACT framing.
      start: value => { controller = value; controller.enqueue(new Uint8Array([78, 65, 67, 84, 1])) },
      cancel: () => channel.close(),
    }, { highWaterMark: this.options.maxBufferedBytes, size: bytes => bytes.byteLength })
    this.sessions.set(token, { channel, writing: false, touch })
    request.signal.addEventListener('abort', abort, { once: true })
    touch()
    try { this.accept!(channel) }
    catch (reason) { channel.fail(reason); return new Response(null, { status: 500 }) }
    return new Response(body, { headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      [SESSION_HEADER]: token,
    } })
  }
}
