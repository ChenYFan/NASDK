import { test } from 'node:test'
import assert from 'node:assert/strict'
import { benchLoadConfig, benchRequests, benchSteps, sleep } from '../_kit.mjs'

test('矩阵清空 VU 阶梯时视为未指定，非法档位仍拒绝', () => {
  assert.equal(benchSteps(undefined), undefined)
  assert.equal(benchSteps(''), undefined)
  assert.equal(benchSteps('  '), undefined)
  assert.deepEqual(benchSteps('1024,4096,16384'), [1024, 4096, 16384])
  for (const value of ['0', '1,', '-1', 'NaN', '1.5']) assert.throws(() => benchSteps(value), /Invalid VU steps/)
})

test('压力调度：VU 与连接独立，多个 VU 共享连接且遵守在途上限', async () => {
  assert.equal(benchLoadConfig(4, { inflight: 16 }).totalInflight, 64)
  assert.equal(benchLoadConfig(8, { vus: 2 }).usedConnections, 2)
  const active = [0, 0], peak = [0, 0], seen = [0, 0]
  const apps = active.map((_, index) => ({
    request(_target, { payload }) {
      active[index]++; seen[index]++
      peak[index] = Math.max(peak[index], active[index])
      return { response: sleep(2).then(() => {
        active[index]--
        return { payload: { seq: payload.seq, length: payload.data.length, data: payload.data } }
      }) }
    },
  }))
  for (const rate of [undefined, 1000]) {
    peak.fill(0); seen.fill(0)
    const result = await benchRequests(apps, { provider: 'fixture', mode: 'echo', size: 3, vus: 4, vuInflight: 2, rate }, 0.04)
    assert.equal(result.vus, 4); assert.equal(result.connections, 2)
    assert.equal(result.totalInflight, 8); assert.equal(result.maxInflightPerConnection, 4)
    assert.equal(result.failed, 0); assert.equal(result.aborted, false)
    assert.ok(seen.every(count => count > 0))
    assert.ok(peak.every(count => count <= 4))
    assert.deepEqual(active, [0, 0])
    if (!rate) assert.deepEqual(peak, [4, 4])
  }
})
