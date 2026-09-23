import { nasdk } from '../utils/nasdk'

export default defineNitroPlugin(async nitro => {
  const { app } = await nasdk()
  nitro.hooks.hook('close', () => app.terminate())
})
