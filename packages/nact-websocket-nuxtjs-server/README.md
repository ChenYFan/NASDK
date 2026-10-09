# nact-websocket-nuxtjs-server

Nuxt / Nitro 原生 WebSocket 路由的 NACT Server Provider。

在 Nitro 插件内注册 Provider，配置 `type: 'websocket-nuxtjs', provider: {}` 并启动 NApp；路由通过 `defineWebSocketHandler(provider.hooks)` 接入。启用 `nitro.experimental.websocket`，由 Nitro/CrossWS 完成升级，不自行监听端口，不操作 Node Req/Res。

`provider.authorize(request)` 可在升级前鉴权。关闭 Provider 释放自己的连接，不关闭 Nitro 服务。客户端使用现有 `nact-websocket-client`，客户端传输类型为 `websocket`。

完整示例见 [运行时接入文档](../../docs/transport/nact/runtime-build.md#nuxt)。
