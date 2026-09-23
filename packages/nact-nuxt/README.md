# @chenyfan/nact-nuxt

Nuxt 3/4 adapter for Nitro 2 / H3 1 using the `node-server` preset. Register the default `NuxtProvider`, start an NApp with a `streamable-http` server entry, and mount `provider.handler()` in a server API route.

The adapter reuses the HTTP session implementation, preserves response backpressure and cancels sessions on disconnect. Bind NApp shutdown to Nitro's close hook. One provider must own all requests for a session; no additional port is opened.

See the repository's `examples/nuxt` and [framework documentation](https://nasdk.eurekac.cn/transport/nact/frameworks).
