export function createTransport({ host, port }) {
  return { type: 'tcp', provider: { host, port } }
}
