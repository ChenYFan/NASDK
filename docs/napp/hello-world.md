# Hello，World！

下面案例将创建两个NApp，其中应用`hello` 生成 `Hello, `，并向 应用 `world` 发起调用。在返回后拼接文本并完成输出。

## 安装

```bash
npm install @chenyfan/nasdk
```

## 创建 World NApp


```js world.mjs
import NApp, { NACAB } from '@chenyfan/nasdk'

const abilities = new NACAB()
abilities.register({
  name: 'appendWorld',
  description: '在文本后拼接 World!',
  execute: ({ text }) => `${text}World!`,
})

const world = new NApp({ id: 'world', server: [{
  type: 'tcp',
  opt: { ip: '127.0.0.1', port: 18900 },
}]})
world.bindProcessor('ability', abilities.nacpAdaptor)

await world.start()
console.log('World NApp is listening on 127.0.0.1:18900')
```

`world` 暴露了一个名为 `appendWorld` 的 Ability，并开启一个在18900端口上的TCP Server供外部链接。

## 创建 Hello NApp


```js hello.mjs
import NApp from '@chenyfan/nasdk'

const hello = new NApp({ id: 'hello' })
await hello.start()
await hello.connect('world', {
  type: 'tcp',
  opt: { ip: '127.0.0.1', port: 18900 },
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
