import { options } from '../k6.mjs'
export { httpSDK, websocketSDK, targetProbe, handleSummary } from '../k6.mjs'
const duration = __ENV.DURATION ?? '10s'
options.scenarios = {
  http_sdk: { executor: 'constant-vus', exec: 'httpSDK', vus: 1, duration },
  websocket_sdk: { executor: 'constant-vus', exec: 'websocketSDK', vus: 1, duration },
  target_probe: { executor: 'constant-arrival-rate', exec: 'targetProbe', rate: 1,
    timeUnit: '1s', duration, preAllocatedVUs: 1, maxVUs: 2 },
}
export { options }
