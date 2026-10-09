import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Channel, ServerHandle } from '@nyirusu/nasdk/NACT'
import StreamableHTTPCore from './handler.ts'
import type { StreamableHTTPServerTransportSpec, StreamableHTTPServerOptions } from './handler.ts'

export type { StreamableHTTPServerTransportSpec, StreamableHTTPServerOptions }

export function toNodeHandler(fetcher: (request: Request) => Response | Promise<Response>) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    request.once('aborted', abort)
    if (request.method === 'GET') response.once('close', abort)
    try {
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, signal: controller.signal }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>
        init.duplex = 'half'
      }
      const result = await fetcher(new Request(new URL(request.url ?? '/', 'http://' + (request.headers.host ?? 'localhost')), init))
      result.headers.forEach((value, key) => response.setHeader(key, value))
      response.writeHead(result.status)
      response.flushHeaders()
      if (!result.body) { response.end(); return }
      const reader = result.body.getReader()
      const cancel = () => { void reader.cancel().catch(() => {}) }
      response.once('close', cancel)
      try {
        while (!response.destroyed) {
          const { value, done } = await reader.read()
          if (done) break
          await new Promise<void>((resolve, reject) => response.write(value, error => error ? reject(error) : resolve()))
        }
      } finally {
        response.off('close', cancel)
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      response.end()
    } catch (reason) {
      if (!response.headersSent) response.writeHead(500).end()
      else response.destroy(reason instanceof Error ? reason : undefined)
    } finally {
      request.off('aborted', abort)
      if (request.method === 'GET') response.off('close', abort)
    }
  }
}

export default class StreamableHTTPServerProvider extends StreamableHTTPCore {
  async listen(options: StreamableHTTPServerOptions, accept: (channel: Channel) => void): Promise<ServerHandle> {
    if (!options.noServer && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535))
      throw Object.assign(new Error('port is required'), { code: 'invalid-port' })
    const sessions = await super.listen(options, accept)
    if (options.noServer) return sessions
    const handler = toNodeHandler(this.fetch)
    const server = createServer((request, response) => { void handler(request, response) })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port, options.host, () => { server.off('error', reject); resolve() })
      })
    } catch (reason) {
      await sessions.close()
      throw reason
    }

    let closing: Promise<void> | undefined
    return {
      close: () => closing ??= (async () => {
        await sessions.close()
        const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        server.closeAllConnections()
        await closed
      })(),
    }
  }

}
