import http from 'k6/http'
import ws from 'k6/ws'
import { check } from 'k6'
import { Trend, Counter } from 'k6/metrics'
import { decode } from 'cbor-x/decode'

const latency = new Trend('nasdk_rtt_ms')
const completed = new Counter('nasdk_completed')
const size = Number(__ENV.PAYLOAD_BYTES ?? 4096)
const data = new Uint8Array(size).fill(0x5a)
const base = __ENV.TARGET_URL ?? 'http://127.0.0.1:18992'
export const options = {
  scenarios: {
    http_sdk: { executor: 'constant-arrival-rate', exec: 'httpSDK', rate: Number(__ENV.HTTP_RATE ?? 50),
      timeUnit: '1s', duration: __ENV.DURATION ?? '30s', preAllocatedVUs: 10, maxVUs: 100 },
    websocket_sdk: { executor: 'constant-vus', exec: 'websocketSDK', vus: Number(__ENV.WS_VUS ?? 4), duration: __ENV.DURATION ?? '30s' },
    target_probe: { executor: 'constant-arrival-rate', exec: 'targetProbe', rate: 1, timeUnit: '1s',
      duration: __ENV.DURATION ?? '30s', preAllocatedVUs: 2, maxVUs: 4 },
  },
  thresholds: { checks: ['rate>0.99'], http_req_failed: ['rate<0.01'], nasdk_rtt_ms: ['p(99)<1000'] },
}
if (__ENV.K6_SCENARIO === 'http') delete options.scenarios.websocket_sdk
if (__ENV.K6_SCENARIO === 'ws') { delete options.scenarios.http_sdk; delete options.thresholds.http_req_failed }
if (__ENV.VU_STEPS) {
  const levels = __ENV.VU_STEPS.split(',').map(Number)
  if (levels.some(level => !Number.isSafeInteger(level) || level < 1)) throw new Error('VU_STEPS must contain positive integers')
  const stages = levels.flatMap(target => [
    { duration: `${__ENV.VU_RAMP_SECONDS ?? 15}s`, target },
    { duration: `${__ENV.VU_HOLD_SECONDS ?? 60}s`, target },
  ]).concat([{ duration: `${__ENV.VU_RAMP_SECONDS ?? 15}s`, target: 0 }])
  const name = __ENV.K6_SCENARIO === 'ws' ? 'websocket_sdk' : 'http_sdk'
  options.scenarios[name] = { executor: 'ramping-vus', exec: name === 'http_sdk' ? 'httpSDK' : 'websocketSDK',
    startVUs: 0, stages, gracefulRampDown: '10s', gracefulStop: '10s' }
  const seconds = levels.length * (Number(__ENV.VU_RAMP_SECONDS ?? 15) + Number(__ENV.VU_HOLD_SECONDS ?? 60)) + Number(__ENV.VU_RAMP_SECONDS ?? 15)
  options.scenarios.target_probe.duration = `${seconds}s`
}
options.summaryTrendStats = ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)']
export function targetProbe() {
  const response = http.post(`${base}/bench/sink`, new Uint8Array([1, 2, 3]).buffer,
    { headers: { 'x-seq': 'probe' }, tags: { probe: 'true' } })
  check(response, { 'same-target SDK probe': r => r.status === 200 && r.headers['X-Length'] === '3' && r.headers['X-Seq'] === 'probe' })
}
export function httpSDK() {
  const seq = `${__VU}-${__ITER}`, begin = Date.now()
  const response = http.post(`${base}/bench/echo`, data.buffer, { headers: { 'x-seq': seq }, responseType: 'binary' })
  const bytes = new Uint8Array(response.body)
  const ok = check(response, { 'HTTP SDK binary echo': r => r.status === 200 && r.headers['X-Seq'] === seq &&
    bytes.length === size && bytes.every(value => value === 0x5a) })
  latency.add(Date.now() - begin, { provider: 'http-gateway' }); if (ok) completed.add(1, { provider: 'http-gateway' })
}
function message(type, from, opt = {}) {
  return { v: { major: 2, minor: 1 }, id: `${from}-${Date.now()}-${Math.random()}`, type, from, to: 'bench-server', t: Date.now(), ...opt }
}
function frame(msg) {
  const body = encodeCBOR(msg), bytes = new Uint8Array(32 + body.length), view = new DataView(bytes.buffer)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  view.setUint32(20, body.length); view.setUint32(24, bytes.length); bytes[30] = 0xcf; bytes[31] = 1
  bytes.set(body, 32); return bytes.buffer
}
// This protocol fixture needs only maps, strings, bytes, booleans and nonnegative integers.
function encodeCBOR(value) {
  const out = []
  const head = (major, n) => {
    if (n < 24) out.push(major * 32 + n)
    else if (n < 256) out.push(major * 32 + 24, n)
    else if (n < 65536) out.push(major * 32 + 25, n >> 8, n & 255)
    else if (n <= 0xffffffff) out.push(major * 32 + 26, n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255)
    else {
      out.push(major * 32 + 27)
      const high = Math.floor(n / 4294967296), low = n % 4294967296
      for (const word of [high, low]) out.push(word >>> 24, word >>> 16 & 255, word >>> 8 & 255, word & 255)
    }
  }
  const write = v => {
    if (typeof v === 'boolean') out.push(v ? 245 : 244)
    else if (typeof v === 'number') head(0, v)
    else if (typeof v === 'string') { head(3, v.length); for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i)) }
    else if (v instanceof Uint8Array) { head(2, v.length); for (const byte of v) out.push(byte) }
    else if (Array.isArray(v)) { head(4, v.length); for (const item of v) write(item) }
    else { const entries = Object.entries(v); head(5, entries.length); for (const [key, item] of entries) { write(key); write(item) } }
  }
  write(value); return Uint8Array.from(out)
}
export function websocketSDK() {
  const from = `k6-${__VU}-${__ITER}`, pending = new Map()
  const response = ws.connect(`${base.replace(/^http/, 'ws')}/nact@ws`, {}, socket => {
    const send = msg => socket.sendBinary(frame(msg))
    let sequence = 0, ready = false
    const request = () => {
      const msg = message('request', from, { meta: { kind: 'ability', target: 'bench.echo' }, payload: { seq: sequence++, data } })
      pending.set(msg.id, { begin: Date.now(), seq: msg.payload.seq }); send(msg)
    }
    socket.on('open', () => send(message('register', from, { meta: {}, payload: { isGateway: false, decl: { events: [], abilities: [] } } })))
    socket.on('binaryMessage', raw => {
      const bytes = new Uint8Array(raw), view = new DataView(raw)
      if (!check(bytes, { 'valid complete NACT frame': b => b.length >= 32 && b[30] === 0xcf && b[31] === 1 &&
        view.getUint32(16) === 0 && view.getUint32(20) === b.length - 32 && view.getUint32(24) === b.length })) { socket.close(); return }
      const msg = decode(bytes.subarray(32))
      if (msg.type !== 'ack' && msg.type !== 'notify') send(message('ack', from, { meta: { parentId: msg.id } }))
       if (msg.type === 'response' && !ready) {
         if (!check(msg, { 'WS registered': m => m.meta.isOk === true })) { socket.close(); return }
         ready = true
         for (let i = 0; i < Number(__ENV.WS_INFLIGHT ?? 1); i++) request()
         return
       }
      if (msg.type !== 'response') return
      const call = pending.get(msg.meta.parentId)
      if (!call) return
      pending.delete(msg.meta.parentId)
      const ok = check(msg, { 'WS SDK binary echo': m => m.meta.isOk && m.payload.seq === call.seq &&
        m.payload.length === size && m.payload.data.every(value => value === 0x5a) })
      latency.add(Date.now() - call.begin, { provider: 'websocket' }); if (ok) completed.add(1, { provider: 'websocket' })
      if (ok) request()
      else socket.close()
    })
    socket.on('error', () => check(false, { 'WS transport healthy': value => value }))
    socket.setInterval(() => {
      if ((!ready && pending.size === 0) || [...pending.values()].some(call => Date.now() - call.begin > 10000)) {
        check(false, { 'WS response within 10s': value => value }); socket.close()
      }
    }, 10000)
    socket.setTimeout(() => socket.close(), Number(__ENV.WS_SESSION_MS ?? 5000))
  })
  check(response, { 'WS upgraded': r => r && r.status === 101 })
}
export function handleSummary(data) {
  return { [__ENV.K6_SUMMARY ?? 'test/bench/results/k6-summary.json']: JSON.stringify(data, null, 2) }
}
