# Hello，World！

下面案例将创建两个NApp，其中应用`hello` 生成 `Hello, `，并向 应用 `world` 发起调用。在返回后拼接文本并完成输出。

## 安装

```bash
npm install @chenyfan/nasdk \
  @chenyfan/nact-websocket-server \
  @chenyfan/nact-websocket-client
```

## 创建 World NApp


```js world.mjs
import NApp, { NACAB } from '@chenyfan/nasdk'
import WebSocketServerProvider from '@chenyfan/nact-websocket-server'

const abilities = new NACAB()
abilities.register({
  name: 'appendWorld',
  description: '在文本后拼接 World!',
  execute: ({ text }) => `${text}World!`,
})

const world = new NApp({ id: 'world', server: [{
  type: 'websocket',
  provider: { host: '127.0.0.1', port: 18900, path: '/nacp' },
}]})
world.nact.use(new WebSocketServerProvider())
world.bindProcessor('ability', abilities.nacpAdaptor)

await world.start()
console.log('World NApp is listening on ws://127.0.0.1:18900/nacp')
```

`world` 暴露了一个名为 `appendWorld` 的 Ability，并通过独立安装的 WebSocket Server Provider 开启监听入口。

## 创建 Hello NApp


```js hello.mjs
import NApp from '@chenyfan/nasdk'
import WebSocketClientProvider from '@chenyfan/nact-websocket-client'

const hello = new NApp({ id: 'hello' })
hello.nact.use(new WebSocketClientProvider())
await hello.start()
await hello.connect('world', {
  type: 'websocket',
  provider: { url: 'ws://127.0.0.1:18900/nacp' },
})

const call = hello.request('world', {
  kind: 'ability',
  target: 'appendWorld',
  payload: { text: 'Hello, ' },
})

const response = await call.response
console.log(response.payload)

await hello.terminate()
```

`hello` 连接到 `world`，并在连接后发送一个请求，激活 `world.appendWorld`，读取消息并输出。

## 运行

先启动 `world`：

```bash
node world.mjs
```

再打开另一个终端运行 `hello`：

```bash
node hello.mjs
```

输出为：

```text
Hello, World!
```

至此，两个 NApp 完成了一次跨进程连接、调用和响应。
