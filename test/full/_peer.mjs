/**
 * full/napp 的可编排服务端。simple/_server.mjs 的加强版：能起多个入口、能按命令 emit、能查状态。
 *
 * 独立进程的理由和 simple 一样：两个 App 本来就该分处两个进程，同进程扮演两端会让测试写出真实部署下
 * 不可能的操作（直接 emit 到对端的 bus），造出人造时序。
 *
 * argv[2] = JSON { id, server: TransportSpec[], opt?: {isGateway, autoMultiGatewayDowngrade} }
 * 命令：{cmd:'emit'|'peers'|'decl'|'connect'|'disconnect'|'request'|'subcount'|'bye'}
 */

import NApp from '../../index.ts'
import { makeNaceb, makeNacab } from '../_kit.mjs'

const cfg = JSON.parse(process.argv[2])

const naceb = makeNaceb()
const nacab = makeNacab()
const app = new NApp({ id: cfg.id, server: cfg.server ?? [], opt: cfg.opt })
app.bindProcessor('event', naceb.nacpAdaptor)
app.bindProcessor('ability', nacab.nacpAdaptor)
await app.start()

const reply = (id, body) => process.send({ id, ...body })

process.on('message', async (m) => {
  try {
    switch (m.cmd) {
      case 'emit':       app.bus.emit(m.key, m.payload); return reply(m.id, { ok: true })
      case 'peers':      return reply(m.id, { peers: app.listConnectedApp() })
      case 'decl':       return reply(m.id, { decl: app.buildDecl() })
      case 'subcount':   return reply(m.id, { subs: app.nacp.getSubCount(), listens: app.nacp.getListenCount() })
      case 'connect':    await app.connect(m.expect, m.spec); return reply(m.id, { ok: true })
      case 'disconnect': return reply(m.id, { dropped: await app.disconnect(m.appId) })
      case 'request': {
        const res = await app.request(m.to, m.opt)
        return reply(m.id, { ok: true, payload: res.payload })
      }
      case 'bye':        await app.terminate(); process.exit(0)
    }
  } catch (e) {
    reply(m.id, { error: e?.code ?? e?.message ?? String(e) })
  }
})
process.send({ ready: true })
