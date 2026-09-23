# @chenyfan/nact-streamable-http-client

NASDK binary HTTP client for browsers, Workers and server runtimes with Fetch/Streams. Register the default provider, start NApp, then connect with `{ type: 'streamable-http', provider: { url } }`.

Supports request headers, credentials, connection cancellation, bounded buffering, finite sequential POSTs and empty-POST keepalive. No Node networking modules or server provider are imported.

See [HTTP transport documentation](https://nasdk.eurekac.cn/transport/nact/http-stream) in the matching NASDK release.
