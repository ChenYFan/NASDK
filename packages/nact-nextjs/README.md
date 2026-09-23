# @chenyfan/nact-nextjs

Next.js App Router adapter for NASDK Streamable HTTP. Register the default `NextJSProvider`, start an NApp with a `streamable-http` server entry, and export GET/POST/DELETE handlers from `provider.routeHandlers()` in your route.

Use one initialized provider per process. The adapter opens no port; it requires a persistent server and session affinity. Initial scope is the Node.js runtime, not stateless Serverless or Pages API routes.

See the repository's `examples/nextjs` and [framework documentation](https://nasdk.eurekac.cn/transport/nact/frameworks).
