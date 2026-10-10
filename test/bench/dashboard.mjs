import { mkdir, writeFile } from 'node:fs/promises'

const datasource = { type: 'prometheus', uid: 'nasdk-prometheus' }
const filter = 'run=~"$run",provider=~"$provider",size=~"$size"'
const panels = []
function panel(title, expr, unit = 'short', type = 'timeseries', extra = {}) {
  const id = panels.length + 1
  panels.push({ id, title, type, datasource, gridPos: { x: ((id - 1) % 2) * 12, y: Math.floor((id - 1) / 2) * 8, w: 12, h: 8 },
    targets: [{ refId: 'A', expr, legendFormat: '{{provider}} {{role}} {{mode}} {{size}}B', ...extra.target }],
    fieldConfig: { defaults: { unit, min: 0, custom: type === 'timeseries' ? {
      drawStyle: 'line', lineInterpolation: 'linear', lineWidth: 2, showPoints: 'never', spanNulls: true,
    } : {} }, overrides: [] }, options: { tooltip: { mode: 'multi', sort: 'desc' },
      legend: { displayMode: 'table', calcs: ['lastNotNull', 'max'] }, ...extra.options } })
}
panel('成功业务消息 / 秒', `sum by(provider,mode)(rate(nasdk_bench_completed_total{${filter}}[10s]))`)
panel('有效业务吞吐 MiB/s（echo 为双向）', `sum by(provider,mode)(rate(nasdk_bench_useful_bytes_total{${filter}}[10s])) / 1048576`)
for (const q of [0.5, 0.95, 0.99]) panel(`RTT P${q * 100}`, `histogram_quantile(${q},sum by(le,provider)(rate(nasdk_bench_latency_seconds_bucket{${filter}}[10s])))`, 's')
panel('失败与未发出 / 秒', `sum by(provider)(rate(nasdk_bench_failed_total{${filter}}[10s]))`, 'short')
panels.at(-1).targets.push({ refId: 'B', expr: `sum by(provider)(rate(nasdk_bench_missed_total{${filter}}[10s]))`, legendFormat: '{{provider}} 未发出' })
panel('两端 RSS', `nasdk_bench_rss_bytes{run=~"$run",provider=~"$provider"}`, 'bytes')
panel('二进制缓冲内存', `nasdk_bench_array_buffers_bytes{run=~"$run",provider=~"$provider"}`, 'bytes')
panel('Socket 写队列', `nasdk_bench_write_queue_bytes{run=~"$run",provider=~"$provider"}`, 'bytes')
panel('事件循环利用率', `nasdk_bench_event_loop_utilization{run=~"$run",provider=~"$provider"}`, 'percentunit')
panel('RTT 分布热力图', `sum by(le)(rate(nasdk_bench_latency_seconds_bucket{${filter}}[10s]))`, 's', 'heatmap', {
  target: { format: 'heatmap', legendFormat: '{{le}}' }, options: { calculate: false, color: { mode: 'scheme', scheme: 'Spectral', steps: 64 } },
})
panel('运行配置与结果表（选定时间范围）', `last_over_time(nasdk_bench_result_msg_per_sec{${filter}}[$__range])`, 'short', 'table', { target: { instant: true, format: 'table' }, options: { showHeader: true } })
const table = panels.at(-1)
for (const [refId, metric] of [['B', 'useful_mib_per_sec'], ['C', 'p99_ms'], ['D', 'failed']]) {
  table.targets.push({ refId, expr: `last_over_time(nasdk_bench_result_${metric}{${filter}}[$__range])`, instant: true, format: 'table' })
}
table.transformations = [
  { id: 'merge', options: {} },
  { id: 'organize', options: { excludeByName: { Time: true, __name__: true, instance: true, job: true, role: true },
    renameByName: { 'Value #A': '完成 msg/s', 'Value #B': '有效 MiB/s', 'Value #C': 'P99 ms', 'Value #D': '失败/丢弃',
       provider: 'Provider', size: '载荷 B', connections: '连接数', inflight: '最大在途/连接', vus: 'VU 数', vuInflight: '在途/VU', totalInflight: '总在途上限', repeat: '重复', run: '运行时间', git: 'Git SHA', mode: '场景' } } },
]
panel('k6 SDK 调用耗时 P99', 'k6_nasdk_rtt_ms_p99{run=~"$run"}', 'ms')
panel('k6 HTTP 失败率', 'k6_http_req_failed_rate{run=~"$run"}', 'percentunit')
panel('k6 实际迭代 / 秒', 'rate(k6_iterations_total{run=~"$run"}[10s])')
panel('k6 到达率未发出', 'rate(k6_dropped_iterations_total{run=~"$run"}[10s])')
panel('目标发送速率与实际完成速率', `nasdk_bench_target_rate{${filter}}`)
panels.at(-1).targets.push({ refId: 'B', expr: `rate(nasdk_bench_completed_total{${filter}}[10s])`, legendFormat: '{{provider}} 完成/s' })
panel('NACT 帧字节吞吐（含协议开销）', `rate(nasdk_bench_tx_bytes_total{run=~"$run",provider=~"$provider"}[10s])`, 'Bps')
panel('k6 成功 SDK 消息 / 秒', 'sum by(provider)(rate(k6_nasdk_completed_total{run=~"$run"}[10s]))')
panel('k6 校验成功率', 'k6_checks_rate{run=~"$run"}', 'percentunit')
panel('k6 活跃 VU / 已分配 VU', 'k6_vus{run=~"$run"}')
panels.at(-1).targets[0].legendFormat = '{{stage}} 活跃 VU'
panels.at(-1).targets.push({ refId: 'B', expr: 'k6_vus_max{run=~"$run"}', legendFormat: '{{stage}} 已分配 VU' })
panel('进程 CPU（100%=一个核）', `nasdk_bench_cpu_percent{run=~"$run",provider=~"$provider"}`, 'percent')
panel('JS 堆占用', `nasdk_bench_heap_bytes{run=~"$run",provider=~"$provider"}`, 'bytes')
for (const [title, metric, unit] of [
  ['完成吞吐对比', 'msg_per_sec', 'short'], ['有效 MiB/s 对比', 'useful_mib_per_sec', 'short'],
  ['P99 对比', 'p99_ms', 'ms'], ['客户端 RSS 峰值对比', 'client_rss_peak_bytes', 'bytes'],
  ['服务端 RSS 峰值对比', 'server_rss_peak_bytes', 'bytes'],
  ['Gateway RSS 峰值对比', 'gateway_rss_peak_bytes', 'bytes'],
]) {
  panel(title, `last_over_time(nasdk_bench_result_${metric}{${filter},stage=~"$stage"}[$__range])`, unit, 'barchart', {
    target: { instant: true, format: 'table' }, options: { orientation: 'vertical', xField: '对比配置', showValue: 'always',
      stacking: 'none', groupWidth: 0.8, barWidth: 0.9, legend: { displayMode: 'hidden' } },
  })
  panels.at(-1).transformations = [{ id: 'organize', options: { excludeByName: { Time: true, __name__: true,
    instance: true, job: true, role: true, run: true, git: true, provider: true, mode: true, size: true,
    inflight: true, connections: true, vus: true, vuInflight: true, totalInflight: true, topology: true, upstreamConnections: true, repeat: true, stage: true, noDelay: true, result_id: true, kind: true },
    renameByName: { scenario: '对比配置', Value: title } } }]
}
panel('功能回归执行状态', 'last_over_time(nasdk_bench_regression_success[$__range])', 'short', 'table', {
  target: { instant: true, format: 'table' }, options: { showHeader: true },
})
panel('功能回归通过 / 失败用例数', 'last_over_time(nasdk_bench_regression_passed[$__range])', 'short', 'table', {
  target: { instant: true, format: 'table' }, options: { showHeader: true },
})
panels.at(-1).targets.push({ refId: 'B', expr: 'last_over_time(nasdk_bench_regression_failed[$__range])', instant: true, format: 'table' })
panel('原生 VU / 已建立业务连接', `nasdk_bench_configured_vus{${filter}}`)
panels.at(-1).targets[0].legendFormat = '{{provider}} {{stage}} VU'
panels.at(-1).targets.push({ refId: 'B', expr: `nasdk_bench_configured_connections{${filter}}`, legendFormat: '{{provider}} {{stage}} 连接' })
panel('原生活跃请求 / 总在途上限', `nasdk_bench_active_requests{${filter}}`)
panels.at(-1).targets[0].legendFormat = '{{provider}} {{stage}} 活跃请求'
panels.at(-1).targets.push({ refId: 'B', expr: `nasdk_bench_inflight_limit{${filter}}`, legendFormat: '{{provider}} {{stage}} 在途上限' })
const dashboard = { uid: process.env.GRAFANA_DASHBOARD_UID ?? 'nasdk-pressure', title: 'NASDK Bench', schemaVersion: 41, version: 1,
  description: '原生 SDK 与 k6 实时压力/回归；吞吐按完整业务响应统计。echo MiB/s 为双向。结果表保留所选时间范围的运行记录。',
  refresh: '10s', timezone: 'browser', time: { from: 'now-6h', to: 'now' }, panels,
  templating: { list: ['run', 'provider', 'size', 'stage'].map(name => ({ name, label: { run: '运行', provider: 'Provider', size: '载荷 B', stage: '阶段' }[name],
    type: 'query', datasource, query: { query: name === 'run'
      ? 'label_values({__name__=~"nasdk_bench_result_msg_per_sec|k6_nasdk_completed_total|nasdk_bench_regression_success"}, run)'
      : `label_values(nasdk_bench_result_msg_per_sec, ${name})`, refId: name },
    multi: true, includeAll: true, allValue: '.*', current: { text: 'All', value: '$__all' }, refresh: 2 })) } }
await mkdir(new URL('./results/', import.meta.url), { recursive: true })
await writeFile(new URL('./results/dashboard.json', import.meta.url), JSON.stringify(dashboard, null, 2))
