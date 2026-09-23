# Next.js Provider 示例

在仓库根目录先执行 `bun install --frozen-lockfile && bun run build`，然后在本目录执行：

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

路由为 `/api/nacp`，App ID 为 `next`，提供二进制 `echo` Ability。客户端使用 `@chenyfan/nact-streamable-http-client`。

示例使用本地包覆盖，便于发布前验证。生产项目正常安装已发布包即可。进程内缓存让所有方法和开发热更新共用 NApp；生产入口还需接入宿主认证。部署到常驻服务，保证会话的 GET/POST/DELETE 到达同一实例。

仓库根目录运行 `bun run test:framework` 可构建两个框架并自动验证生产路由。

为避免把包含示例自身的仓库根目录递归安装为依赖，本地示例直接引用根目录 `dist/index.js`。正式应用改为从 `@chenyfan/nasdk` 导入。Provider 仍以独立包安装和验证。
