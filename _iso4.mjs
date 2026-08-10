import NApp from './index.ts'
import { NACAB } from './NACAB/index.ts'
const P = 18906
const nacab = new NACAB()
const srv = new NApp({ id: 'core', server: [{ type: 'tcp', opt: { ip: '127.0.0.1', port: P } }] })
srv.bindProcessor('ability', nacab.nacpAdaptor)
await srv.start()
const cli = new NApp({ id: 'web' })
await cli.start()
await cli.connect('core', { type: 'tcp', opt: { ip: '127.0.0.1', port: P } })
console.log('connected')

const [sub, stream] = cli.subscribe('core', 'demo:*')
console.log('subscribe returned')
srv.bus.emit('demo:hello', { n: 1 })
srv.bus.emit('demo:world', { n: 2 })
console.log('emitted 2')

const got = []
const t0 = Date.now()
for await (const chunk of stream) {
  console.log('  chunk', JSON.stringify(chunk), `+${Date.now() - t0}ms`)
  got.push(chunk.n)
  if (got.length === 2) break
}
console.log('loop exited, got =', got)
const res = await sub
console.log('sub resolved isOk =', res.meta.isOk, 'targetSubId =', res.payload?.targetSubId)
await cli.terminate(); await srv.terminate()
console.log('done')
process.exit(0)
