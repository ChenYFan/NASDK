import { readdir } from 'node:fs/promises'

// Compile dependencies before consumers; do not rely on workspace alphabetical order.
const mode = process.argv[2]
if (mode !== 'build' && mode !== 'typecheck') throw new Error('expected build or typecheck')
const names = await readdir(new URL('../packages/', import.meta.url))
const pending = new Set(names)
const done = new Set()
async function compile(project) {
  const child = Bun.spawn(['bun', 'x', '--bun', '--no-install', 'tsc', '-p',
    `${project}/${mode === 'build' ? 'tsconfig.build.json' : 'tsconfig.json'}`,
    ...(mode === 'typecheck' ? ['--noEmit'] : [])], { stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited) process.exit(1)
}
await compile('.')
while (pending.size) {
  let moved = false
  for (const name of pending) {
    const pkg = await Bun.file(`packages/${name}/package.json`).json()
    const deps = Object.keys(pkg.dependencies ?? {}).map(key => key.replace('@chenyfan/', ''))
    if (deps.some(dep => pending.has(dep) && !done.has(dep))) continue
    await compile(`packages/${name}`)
    pending.delete(name); done.add(name); moved = true
  }
  if (!moved) throw new Error('cyclic provider dependencies')
}
