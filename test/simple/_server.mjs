/**
 * simple/napp 的服务端，跑在独立子进程里。
 *
 * 为什么单独一个进程：两个 App 本来就该在两个进程里。同进程里既当服务端又当客户端时，测试能直接
 * `server.bus.emit(...)` 去戳对端的 bus —— 那是真实部署下不存在的操作，写出来的时序也是人造的。
 * 分开之后，「让对端发一条事件」只能通过 IPC 请它自己发，和真实情况一致。
 *
 * 约定：起好后 process.send({ready:true})；父进程用 {cmd:'emit'|'bye'} 驱动。
 */

import NApp from '../../index.ts'
import { NACEB, PipelineHandler, TaskHandler } from '../../NACEB/index.ts'
import { NACAB } from '../../NACAB/index.ts'

const specs = JSON.parse(process.argv[2])          // 要暴露的入口，可以多个

class CountDown extends TaskHandler {
  name = 'countDown'
  description = '从 n 数到 0，每步上报一次'
  async execute() {
    this.processingResultReport({ at: this.input })  // 显式上报，请求方 onProcess 才收得到
    return this.input - 1
  }
}

class CountDownPipe extends PipelineHandler {
  name = 'countDownPipe'
  description = '数到 0 为止'
  next(lastResult) {
    if (lastResult === undefined) return { task: 'countDown', input: this.event.payload.from }
    if (lastResult <= 0) return { task: '$terminal', input: { reached: 0 } }
    return { task: 'countDown', input: lastResult }
  }
}

const naceb = new NACEB({
  pipelineHandlers: [new CountDownPipe()],
  taskHandlers: [new CountDown()],
  eventAlias: [{ eventName: 'countdown', pipelineName: 'countDownPipe', description: '数到 0' }],
})

const nacab = new NACAB()
nacab.register({ name: 'math.add', description: '两数相加', execute: (p) => p.a + p.b })

const app = new NApp({ id: 'core', server: specs })
app.bindProcessor('event', naceb.nacpAdaptor)
app.bindProcessor('ability', nacab.nacpAdaptor)
await app.start()

process.on('message', async (m) => {
  if (m?.cmd === 'emit') app.bus.emit(m.key, m.payload)
  if (m?.cmd === 'peers') process.send({ peers: app.listConnectedApp() })
  if (m?.cmd === 'bye') { await app.terminate(); process.exit(0) }
})
process.send({ ready: true })
