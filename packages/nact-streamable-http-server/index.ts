import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import type { ServerHandle, TransportChannel } from '@chenyfan/nasdk/NACT'
import HTTPHandlerProvider from './handler.ts'
import type { StreamableHTTPServerOptions as HandlerOptions } from './handler.ts'
export { SESSION_HEADER } from './handler.ts'

export interface StreamableHTTPServerOptions extends HandlerOptions {
  host: string
  port: number
  path?: string
}
export interface StreamableHTTPServerTransportSpec {
  type: 'streamable-http'
  provider: StreamableHTTPServerOptions
  nact?: { chunkSize?: number }
}

/** Owns a listening HTTP server. Framework adapters import the node-free /handler entry instead. */
export default class StreamableHTTPServerProvider extends HTTPHandlerProvider {
  async listen(options: StreamableHTTPServerOptions, accept: (channel: TransportChannel) => void): Promise<ServerHandle> {
    const sessions = await super.listen(options, accept)
    const server = createServer(async (req, res) => {
      const controller = new AbortController()
      res.once('close', () => controller.abort())
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== (options.path ?? '/nacp')) { res.writeHead(404).end(); return }
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers))
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        const request = new Request(url, {
          method: req.method, headers, signal: controller.signal,
          ...(req.method !== 'GET' && req.method !== 'HEAD'
            ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
        })
        const response = await this.handle(request)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        res.flushHeaders()
        if (!response.body) { res.end(); return }
        const reader = response.body.getReader()
        const cancel = () => { void reader.cancel().catch(() => {}) }
        res.once('close', cancel)
        try {
          while (!res.destroyed) {
            const { value, done } = await reader.read()
            if (done) break
            await new Promise<void>((resolve, reject) => res.write(value, error => error ? reject(error) : resolve()))
          }
        } finally { res.off('close', cancel); await reader.cancel().catch(() => {}); reader.releaseLock() }
        res.end()
      } catch {
        if (!res.headersSent) res.writeHead(500).end()
        else res.destroy()
      }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port, options.host, () => { server.off('error', reject); resolve() })
      })
    } catch (reason) { await sessions.close(); throw reason }
    let closing: Promise<void> | undefined
    return { close: () => closing ??= (async () => {
      await sessions.close()
      const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await closing
    })() }
  }
}
