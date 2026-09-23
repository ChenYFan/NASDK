import NApp, { NACAB } from '../../../../dist/index.js'
import NuxtProvider from '@chenyfan/nact-nuxt'

let ready: Promise<{ app: NApp; provider: NuxtProvider }> | undefined
export function nasdk() {
  return ready ??= (async () => {
    const provider = new NuxtProvider()
    const app = new NApp({ id: 'nuxt', server: [{ type: 'streamable-http', provider: {} }] })
    const abilities = new NACAB()
    abilities.register({ name: 'echo', description: 'Echo binary payload', execute: value => value })
    app.bindProcessor('ability', abilities.nacpAdaptor)
    app.nact.use(provider)
    await app.start()
    return { app, provider }
  })()
}
