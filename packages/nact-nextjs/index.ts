import StreamableHTTPServerProvider from '@chenyfan/nact-streamable-http-server/handler'
export type { StreamableHTTPServerOptions } from '@chenyfan/nact-streamable-http-server/handler'
export type {
  StreamableHTTPServerOptions as NextJSOptions,
  StreamableHTTPServerTransportSpec as NextJSTransportSpec,
} from '@chenyfan/nact-streamable-http-server/handler'

/** Mount in an App Router route.ts. Lifecycle remains owned by the process's NApp. */
export default class NextJSProvider extends StreamableHTTPServerProvider {
  routeHandlers() {
    return { GET: this.handle, POST: this.handle, DELETE: this.handle }
  }
}
