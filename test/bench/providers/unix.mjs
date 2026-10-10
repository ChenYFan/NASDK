import { join } from 'node:path'
import { tmpdir } from 'node:os'
export function createTransport({ name }) {
  return { type: 'unix', provider: { path: join(tmpdir(), `nasdk-${name}.sock`) } }
}
