import http from 'node:http'
import NApp from '../../index.ts'
import { NACAB } from '../../NACAB/index.ts'
import WebSocketServerProvider from '../../packages/nact-websocket-server/index.ts'
import { benchPeer, benchMeter, tcp } from '../_kit.mjs'

const cleanups = [], t = { after: fn => cleanups.push(fn) }
const spec = tcp(18993), peer = await benchPeer(t, spec)
const meter = benchMeter(), client = meter.instrument(new NApp({ id: 'k6-gateway', opt: { heartbeatIntervalMs: false } }))
await client.start(); await client.connect('bench-server', spec)
const provider = new WebSocketServerProvider()
const app = new NApp({ id: 'bench-server', server: [{ type: 'websocket', provider: { noServer: true } }],
  opt: { heartbeatIntervalMs: false } })
app.nact.use(provider)
const nacab = new NACAB()
for (const mode of ['sink', 'echo']) nacab.register({ name: `bench.${mode}`, description: mode,
  execute: p => ({ seq: p.seq, length: p.data.byteLength, ...(mode === 'echo' && { data: p.data }) }) })
app.bindProcessor('ability', nacab.nacpAdaptor); await app.start()
meter.labels = { role: 'gateway', provider: 'tcp', mode: 'k6' }; meter.start(); await peer.ask('start')
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ok'); return }
  if (req.method !== 'POST' || !['/bench/sink', '/bench/echo'].includes(req.url)) { res.writeHead(404).end(); return }
  try {
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 ** 2) throw new Error('payload too large'); chunks.push(chunk) }
    const seq = req.headers['x-seq'] ?? '0'
    const response = await client.request('bench-server', { kind: 'ability', target: req.url.replace('/bench/', 'bench.'),
      payload: { seq, data: Buffer.concat(chunks) } }).response
    res.setHeader('x-seq', response.payload.seq); res.setHeader('x-length', response.payload.length)
    res.end(response.payload.data ?? 'ok')
  } catch (error) { res.writeHead(500).end(error.message) }
})
provider.attach(server, { path: '/nact@ws' })
server.listen(18992, '0.0.0.0', () => console.log('k6 target ready'))
process.on('SIGTERM', async () => {
  meter.stop(); await client.terminate(); await app.terminate(); server.close()
  for (const cleanup of cleanups.reverse()) await cleanup()
})
