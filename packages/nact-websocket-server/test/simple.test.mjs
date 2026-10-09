import { test } from 'node:test'
import { checkProviderDuplex } from '../../../test/_kit.mjs'
test('建连后双向交付完整二进制 NACT 帧', { timeout: 5000 }, t => checkProviderDuplex(t, import.meta.url))
