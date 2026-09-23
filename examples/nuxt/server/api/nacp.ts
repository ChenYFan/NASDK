import { nasdk } from '../utils/nasdk'

export default defineEventHandler(async event => (await nasdk()).provider.handler()(event))
