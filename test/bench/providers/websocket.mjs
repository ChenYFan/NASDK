export function createTransport({ host, port }) {
  return { type: 'websocket', provider: { host, port, path: '/ws', url: `ws://${host}:${port}/ws` } }
}
