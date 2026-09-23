# Nuxt Provider 示例

在仓库根目录先执行 `bun install --frozen-lockfile && bun run build`，然后在本目录执行：

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

路由为 `/api/nacp`，App ID 为 `nuxt`，提供二进制 `echo` Ability。客户端使用 `@chenyfan/nact-streamable-http-client`。

示例固定 `node-server` preset，并用 Nitro `close` hook 关闭 NApp。Provider 面向 Nuxt 3/4 的 Nitro 2、H3 1；入口认证和部署请求亲和由应用配置。

仓库根目录运行 `bun run test:framework` 可构建两个框架并自动验证生产路由。

为避免把包含示例自身的仓库根目录递归安装为依赖，本地示例直接引用根目录 `dist/index.js`。正式应用改为从 `@chenyfan/nasdk` 导入。Provider 仍以独立包安装和验证。
