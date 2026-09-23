# @chenyfan/nact-streamable-http-server

NASDK binary HTTP transport. The default `StreamableHTTPServerProvider` owns an HTTP listener (`host`, `port`, optional `path`). Register it with `app.nact.use()` before `app.start()` using a `streamable-http` server spec.

The `/handler` entry provides the same session protocol through `handle(Request): Promise<Response>` without opening a port or importing server networking modules. Next.js and Nuxt providers use this entry.

Sessions use a streaming GET, sequential binary POSTs and DELETE. Configure `authorize`, `maxSessions`, `maxBodyBytes`, `maxBufferedBytes` and `idleTimeoutMs` on the server spec. Sessions require a persistent process and routing affinity. Closing the handle closes its sessions.

See [HTTP transport documentation](https://nasdk.eurekac.cn/transport/nact/http-stream) in the matching NASDK release.
