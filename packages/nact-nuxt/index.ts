import { defineEventHandler, toWebRequest } from 'h3'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import StreamableHTTPServerProvider from '@chenyfan/nact-streamable-http-server/handler'
export type { StreamableHTTPServerOptions } from '@chenyfan/nact-streamable-http-server/handler'
export type {
  StreamableHTTPServerOptions as NuxtOptions,
  StreamableHTTPServerTransportSpec as NuxtTransportSpec,
} from '@chenyfan/nact-streamable-http-server/handler'

/** Nuxt 3/4 with Nitro 2 (H3 1). Register handler() as a server/api route. */
export default class NuxtProvider extends StreamableHTTPServerProvider {
  handler() {
    return defineEventHandler(async event => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      const res = event.node.res
      res.once('close', abort)
      try {
        const response = await this.handle(new Request(toWebRequest(event), { signal: controller.signal }))
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        // Send session headers before the first NACP message; client registration depends on them.
        res.flushHeaders()
        if (!response.body) { res.end(); return }
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res)
      } catch (reason) {
        if (!controller.signal.aborted) throw reason
      } finally { res.off('close', abort) }
    })
  }
}
