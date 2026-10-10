import { readFile } from 'node:fs/promises'
import { publishResult } from './publish.mjs'

const files = process.argv.slice(2)
if (!files.length) throw new Error('Pass one or more JSONL result files')
let count = 0
for (const file of files) {
  for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
    await publishResult(JSON.parse(line), process.env.NASDK_METRICS_URL ?? 'http://127.0.0.1:18991')
    count++
  }
}
console.log(`Uploaded ${count} complete result records`)
