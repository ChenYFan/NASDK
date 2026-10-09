import { test } from 'node:test'
import { checkProviderFrames, checkProviderClose } from '../../../test/_kit.mjs'
test('多段帧、空帧和连续帧保持字节与边界', { timeout: 5000 }, t => checkProviderFrames(t, import.meta.url))
test('关闭通知只触发一次，关闭后拒绝发送', { timeout: 5000 }, t => checkProviderClose(t, import.meta.url))
