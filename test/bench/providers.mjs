export const providers = ['unix', 'tcp', 'websocket', 'streamable-http']
export async function createTransport(provider, options = {}) {
  if (!providers.includes(provider)) throw new Error(`Unknown Provider: ${provider}`)
  const plugin = await import(`./providers/${provider}.mjs`)
  return plugin.createTransport({ host: process.env.NASDK_PRESSURE_HOST ?? '127.0.0.1',
    port: 18996, name: `pressure-${crypto.randomUUID().slice(0, 8)}`, ...options })
}
