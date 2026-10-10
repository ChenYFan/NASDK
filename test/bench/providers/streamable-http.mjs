export function createTransport({ host, port, users = 0, bufferMiB = 64 }) {
  return { type: 'streamable-http', provider: { host, port, path: '/nact@http',
    url: `http://${host}:${port}/nact@http`, idleTimeoutMs: 0, maxSessions: Math.max(1024, users + 1),
    maxBodyBytes: 4 * 1024 ** 2, maxBufferedBytes: bufferMiB * 1048576 } }
}
