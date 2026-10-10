import { readFile } from 'node:fs/promises'

const base = process.env.GRAFANA_URL
if (!base) throw new Error('Set GRAFANA_URL')
const token = process.env.GRAFANA_TOKEN
if (!token) throw new Error('Set GRAFANA_TOKEN to a service account token with datasource and dashboard write permissions')
const prometheus = process.env.GRAFANA_PROMETHEUS_URL
if (!prometheus) throw new Error('Set GRAFANA_PROMETHEUS_URL to the Prometheus URL reachable from your Grafana server')
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  if (!response.ok) throw new Error(`Grafana ${path}: ${response.status} ${result.message ?? 'request failed'}`)
  return result
}
const sources = await api('/api/datasources')
const current = sources.find(source => source.uid === 'nasdk-prometheus')
const source = { uid: 'nasdk-prometheus', name: 'NASDK Prometheus', type: 'prometheus', access: 'proxy',
  url: prometheus, isDefault: false, jsonData: { httpMethod: 'POST', timeInterval: '2s' } }
await api(current ? '/api/datasources/uid/nasdk-prometheus' : '/api/datasources', current ? 'PUT' : 'POST', source)
const health = await api('/api/datasources/uid/nasdk-prometheus/health')
if (health.status !== 'OK') throw new Error(`Grafana datasource unhealthy: ${health.message}`)
const dashboard = JSON.parse(await readFile(new URL('./results/dashboard.json', import.meta.url)))
const uid = process.env.GRAFANA_DASHBOARD_UID ?? dashboard.uid
dashboard.uid = uid
const found = await api('/api/search?type=dash-db')
let folderUid = ''
if (found.some(item => item.uid === uid)) {
  const current = await api(`/api/dashboards/uid/${uid}`)
  dashboard.id = current.dashboard.id
  dashboard.version = current.dashboard.version
  folderUid = current.meta.folderUid ?? ''
}
const result = await api('/api/dashboards/db', 'POST', { dashboard, folderUid, overwrite: true, message: 'NASDK benchmark dashboard' })
console.log(`NASDK Grafana dashboard: ${base}${result.url}`)
