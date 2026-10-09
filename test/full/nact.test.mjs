// Framing/codec unit tests, plus real-carrier checks of Peer lifecycle across the three transports.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as flush } from 'node:timers/promises'
import { buildMessage } from '../../NACP/types.ts'
import { deferred, controlledChannel as controlled, acceptanceNotifyOpt } from '../_kit.mjs'

import { cborCodec } from '../../NACT/codec.ts'
import {
  FRAME_HEADER_SIZE, MAX_FRAME_SIZE, DEFAULT_CHUNK, NACT_VERSION, MAGIC_BY_VERSION,
  checkFrameHeader, packFrameHeader, makeReassembler, makeFrameReceiver, splitAndEmit, toHex,
} from '../../NACT/framing.ts'
import { makeFrameSplitter, readFrameSize, FRAME_HEADER_SIZE as SHARED_FRAME_HEADER_SIZE } from '../../packages/nact-provider-shared/index.ts'
import { NACTError } from '../../NACT/errors.ts'
import { NACTEvent } from '../../NACT/events.ts'
import { startApp, startPair, tcp, PORT, sleep } from '../_kit.mjs'

const aMsg = (payload) => ({
  v: { major: 1, minor: 0 }, type: 'notify', id: 'm1', from: 'a', to: 'b', t: 1,
  meta: { parentId: 'p', targetSubName: 'x', hitSubName: 'x' }, payload,
})

const notify = payload => buildMessage('me', 'notify', 'them', { ...acceptanceNotifyOpt, payload })

test('sendToPeer 等全部帧被接纳，并保持并发提交的包顺序', { timeout: 3000 }, async t => {
  const arrivals = []
  const { app, peer } = await controlled(t, frame => {
    const gate = deferred()
    arrivals.push({ frame, gate })
    return gate.promise
  })
  const messages = [notify(new Uint8Array(200)), notify('second')]
  const counts = messages.map(message => Math.ceil(cborCodec.encode(message).length / 64))
  const done = [false, false]
  const sends = messages.map((message, i) => app.nact.sendToPeer(peer.id, message).then(result => {
    done[i] = true
    return result
  }))
  await flush()
  assert.equal(arrivals.length, 1)
  assert.deepEqual(done, [false, false])
  for (let i = 0; i < counts[0] + counts[1]; i++) {
    assert.equal(arrivals.length, i + 1, '前一帧尚未接纳时不提交下一帧')
    assert.equal(done[i < counts[0] ? 0 : 1], false, '整个包仍在等待接纳')
    arrivals[i].gate.resolve()
    await flush()
    if (i === counts[0] - 1) assert.deepEqual(done, [true, false])
  }
  assert.deepEqual(await Promise.all(sends), [true, true])
  const received = []
  const receiver = makeFrameReceiver(bytes => received.push(cborCodec.decode(bytes)), assert.fail)
  for (const { frame } of arrivals) receiver.receive(frame)
  assert.deepEqual(received, messages)
  assert.equal(await app.nact.sendToPeer('missing', messages[0]), false)
})

for (const asynchronous of [false, true]) {
  test(`Provider ${asynchronous ? 'reject' : 'throw'}：当前包和排队包都失败，后续帧停止提交`, async t => {
    const reason = Object.assign(new Error('refused'), { code: 'provider-refused' })
    let calls = 0
    const { app, peer } = await controlled(t, () => {
      if (++calls !== 2) return
      if (asynchronous) return Promise.reject(reason)
      throw reason
    })
    const errors = []
    app.bus.listen('nact:peer:error', value => errors.push(value))
    const check = error => error.code === reason.code && error.phase === 'outbound' && error.cause === reason
    await Promise.all([
      assert.rejects(app.nact.sendToPeer(peer.id, notify(new Uint8Array(200))), check),
      assert.rejects(app.nact.sendToPeer(peer.id, notify('queued')), check),
    ])
    await flush()
    assert.equal(calls, 2)
    assert.equal(errors.length, 1)
    assert.equal(app.nact.getPeer(peer.id), undefined)
  })
}

test('Provider 接纳中断连：即使 send 永不完成，所有等待方仍会 reject', { timeout: 3000 }, async t => {
  const gate = deferred()
  let calls = 0
  const { app, peer, channel } = await controlled(t, () => { calls++; return gate.promise })
  const sends = [notify('first'), notify('second')].map(message =>
    assert.rejects(app.nact.sendToPeer(peer.id, message), error => error.code === 'transport-closed'))
  await flush()
  channel.close()
  await Promise.all(sends)
  gate.resolve()
  await flush()
  assert.equal(calls, 1, '迟到的接纳不能继续发送排队帧')
})

test('Provider 接纳成功后的错误通过事件报告，不改变已完成的 Promise', async t => {
  const { app, peer, errors } = await controlled(t, () => {})
  const accepted = app.nact.sendToPeer(peer.id, notify('queued in provider'))
  assert.equal(await accepted, true)
  const reasons = []
  app.bus.listen('nact:peer:error', value => reasons.push(value.reason))
  for (const handler of errors) handler(Object.assign(new Error('late failure'), { code: 'late-failure' }))
  assert.equal(await accepted, true)
  assert.deepEqual(reasons, ['late-failure'])
})

/** Feed all splitAndEmit frames to a reassembler; returns the decoded result. */
function roundTrip(msg, chunkSize) {
  const bytes = cborCodec.encode(msg)
  let got = null, frames = 0
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(`reasm error: ${r}`))
  splitAndEmit(bytes, chunkSize, (header, body) => {
    frames++
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const id = toHex(header.subarray(0, 16))
    const offset = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(body, offset)
    reasm.advance(id, offset, body.length)
  })
  return { got, frames }
}

// ── codec ──

test('codec 覆盖各种 payload 类型', () => {
  const cases = [
    {}, null, 0, '', false,
    { deep: { nested: { arr: [1, 'two', null, true] } } },
    { bin: new Uint8Array([0, 127, 128, 255]) },
    { big: 2 ** 40 },
    { neg: -1.5 },
    { unicode: '中文🎉' },
    { many: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])) },
  ]
  for (const payload of cases) {
    const back = cborCodec.decode(cborCodec.encode(aMsg(payload)))
    assert.deepEqual(back.payload, payload, `payload = ${JSON.stringify(payload)?.slice(0, 40)}`)
  }
})

test('codec：信封字段一个不丢', () => {
  const msg = aMsg({ x: 1 })
  assert.deepEqual(cborCodec.decode(cborCodec.encode(msg)), msg)
})

test('codec.decode 接受 Uint8Array 和 ArrayBuffer', () => {
  const bytes = cborCodec.encode(aMsg({ x: 1 }))
  assert.deepEqual(cborCodec.decode(bytes), aMsg({ x: 1 }))
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  assert.deepEqual(cborCodec.decode(ab), aMsg({ x: 1 }))
})

test('codec.decode 遇到垃圾字节抛错', () => {
  assert.throws(() => cborCodec.decode(new Uint8Array([0xff, 0xff, 0xff, 0xff])))
})

// ── frame header ──

test('头布局：16B msgId + offset + totalSize + thisFrameSize + 保留 + magic + version', () => {
  const msgId = new Uint8Array(16).fill(0xab)
  const h = packFrameHeader(msgId, 100, 5000, 200)
  assert.equal(h.length, 32)

  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  assert.equal(toHex(h.subarray(0, 16)), 'ab'.repeat(16))
  assert.equal(dv.getUint32(16), 100, 'offset')
  assert.equal(dv.getUint32(20), 5000, 'totalSize')
  assert.equal(dv.getUint32(24), FRAME_HEADER_SIZE + 200, 'thisFrameSize')
  assert.equal(dv.getUint16(28), 0, '保留位')
  assert.equal(dv.getUint8(31), NACT_VERSION, 'version 在最后一个字节 —— 跨版本唯一位置稳定的字段')
  assert.equal(checkFrameHeader(h), null)
})

test('版本先判、magic 后判', () => {
  const h = packFrameHeader(new Uint8Array(16), 0, 10, 10)

  const badBoth = Uint8Array.from(h); badBoth[30] = 0; badBoth[31] = 99
  assert.equal(checkFrameHeader(badBoth), 'version-mismatch', '版本不认就不谈 magic')

  const badMagic = Uint8Array.from(h); badMagic[30] = 0
  assert.equal(checkFrameHeader(badMagic), 'bad-magic')
})

test('msgId 每条消息不同，同条消息内相同', () => {
  const b = cborCodec.encode(aMsg({ blob: 'x'.repeat(5000) }))
  const ids1 = new Set(); const ids2 = new Set()
  splitAndEmit(b, 1024, (h) => ids1.add(toHex(h.subarray(0, 16))))
  splitAndEmit(b, 1024, (h) => ids2.add(toHex(h.subarray(0, 16))))
  assert.equal(ids1.size, 1)
  assert.equal(ids2.size, 1)
  assert.notDeepEqual([...ids1], [...ids2], '两次发送是两个 msgId')
})

// ── split / reassemble ──

test('帧数随 chunkSize 变化，结果始终一致', () => {
  const msg = aMsg({ blob: 'q'.repeat(20 * 1024) })
  let prev = Infinity
  for (const chunkSize of [64, 256, 1024, 8192, DEFAULT_CHUNK.tcp]) {
    const { got, frames } = roundTrip(msg, chunkSize)
    assert.deepEqual(got, msg, `chunkSize=${chunkSize}`)
    assert.ok(frames <= prev, `chunkSize 越大帧数越少：${chunkSize} → ${frames}`)
    prev = frames
  }
})

test('chunkSize 比头还小也能工作 —— bodyMax 至少 1', () => {
  const msg = aMsg({ s: 'abcdefgh' })
  const { got, frames } = roundTrip(msg, 1)
  assert.deepEqual(got, msg)
  assert.ok(frames > 10, `每帧体只有 1 字节，分片成 ${frames} 帧`)
})

test('空消息、1 字节、正好等于 chunkSize 的边界', () => {
  for (const payload of [{}, { s: '' }, { s: 'a' }]) {
    const { got } = roundTrip(aMsg(payload), 1024)
    assert.deepEqual(got, aMsg(payload))
  }
  // sizes right at the one-frame boundary
  const bodyMax = 1024 - FRAME_HEADER_SIZE
  for (const delta of [-1, 0, 1]) {
    const filler = 'z'.repeat(Math.max(1, bodyMax + delta - 80))
    const { got } = roundTrip(aMsg({ filler }), 1024)
    assert.equal(got.payload.filler.length, filler.length)
  }
})

test('帧乱序到达也能重组', () => {
  const msg = aMsg({ blob: 'r'.repeat(10 * 1024) })
  const bytes = cborCodec.encode(msg)
  const frames = []
  splitAndEmit(bytes, 512, (h, b) => frames.push({ h, b: Uint8Array.from(b) }))

  let got = null
  const reasm = makeReassembler((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
  for (const { h, b } of [...frames].reverse()) {       // feed in reverse order
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    const id = toHex(h.subarray(0, 16))
    const off = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(b, off)
    reasm.advance(id, off, b.length)
  }
  assert.deepEqual(got, msg)
})

test('两个包的帧交错到达，各自重组', () => {
  const m1 = aMsg({ tag: 'one', blob: 'a'.repeat(3000) })
  const m2 = aMsg({ tag: 'two', blob: 'b'.repeat(3000) })
  const collect = (msg) => {
    const out = []
    splitAndEmit(cborCodec.encode(msg), 512, (h, b) => out.push({ h, b: Uint8Array.from(b) }))
    return out
  }
  const f1 = collect(m1), f2 = collect(m2)

  const done = []
  const reasm = makeReassembler((full) => done.push(cborCodec.decode(full)), (r) => assert.fail(r))
  const feed = ({ h, b }) => {
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
    const id = toHex(h.subarray(0, 16))
    const off = dv.getUint32(16)
    reasm.ensure(id, dv.getUint32(20)).set(b, off)
    reasm.advance(id, off, b.length)
  }
  for (let i = 0; i < Math.max(f1.length, f2.length); i++) { f1[i] && feed(f1[i]); f2[i] && feed(f2[i]) }

  assert.equal(done.length, 2)
  assert.deepEqual(done.map(d => d.payload.tag).sort(), ['one', 'two'])
})

test('重复的帧被拒（received 计数骗不过区间集）', () => {
  const errs = []
  const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
  reasm.ensure('d', 100)
  reasm.advance('d', 0, 50)
  reasm.advance('d', 0, 50)       // same range twice: count reaches 100 but ranges overlap
  assert.deepEqual(errs, ['overlapping-frame'])
})

test('advance 到未知 msgId 是静默空操作', () => {
  const errs = []
  const reasm = makeReassembler(() => {}, (r) => errs.push(r))
  assert.doesNotThrow(() => reasm.advance('从未 ensure 过', 0, 10))
  assert.deepEqual(errs, [])
})

test('clear 之后旧 msgId 的帧不再累积', () => {
  let done = 0
  const reasm = makeReassembler(() => done++, () => {})
  reasm.ensure('x', 100)
  reasm.advance('x', 0, 50)
  reasm.clear()
  reasm.advance('x', 50, 50)      // table cleared, frame has nowhere to go
  assert.equal(done, 0)
})

// ── per-frame receive ──

/** All frames of one packet, each frame is [header, body] (matches NACT sender side). */
function framesOf(bytes, chunkSize) {
  const out = []
  splitAndEmit(bytes, chunkSize, (h, b) => out.push([h, b]))
  return out
}
/** Concatenate a frame's parts into one contiguous buffer. */
const flat = (frame) => {
  const out = new Uint8Array(frame.reduce((n, s) => n + s.length, 0))
  let at = 0
  for (const s of frame) { out.set(s, at); at += s.length }
  return out
}
/** Split one frame into multiple Uint8Arrays of n bytes each. */
const segmentsBy = (bytes, n) => {
  const out = []
  for (let i = 0; i < bytes.length; i += n) out.push(bytes.subarray(i, i + n))
  return out
}
/** Same underlying memory and position → zero copy. */
const sameMemory = (a, b) => a.buffer === b.buffer && a.byteOffset === b.byteOffset && a.length === b.length

test('快速路径：单帧包，帧是一个 Uint8Array，帧体直接引用原内存', () => {
  const msg = aMsg({ blob: 'f'.repeat(3000) })
  const [frame] = framesOf(cborCodec.encode(msg), 1024 * 1024)
  const wire = flat(frame)

  let got
  const rx = makeFrameReceiver((full) => { got = full }, (r) => assert.fail(r))
  rx.receive([wire])
  assert.ok(sameMemory(got, wire.subarray(FRAME_HEADER_SIZE)), '零拷贝：交给解码的是原内存的 subarray')
  assert.deepEqual(cborCodec.decode(got), msg)
})

test('快速路径：单帧包，帧是 [header, body]，body 原样交出', () => {
  const msg = aMsg({ blob: 'g'.repeat(3000) })
  const [frame] = framesOf(cborCodec.encode(msg), 1024 * 1024)

  let got
  const rx = makeFrameReceiver((full) => { got = full }, (r) => assert.fail(r))
  rx.receive(frame)
  assert.equal(got, frame[1], '零拷贝：直接是 body 本身')
  assert.deepEqual(cborCodec.decode(got), msg)
})

test('快速路径：单帧包但帧体跨多个 Uint8Array，拷贝一次后正确', () => {
  const msg = aMsg({ blob: 'h'.repeat(3000) })
  const [frame] = framesOf(cborCodec.encode(msg), 1024 * 1024)
  const wire = flat(frame)

  for (const n of [1, 7, 31, 32, 33, 1000, wire.length - 1]) {
    let got
    const rx = makeFrameReceiver((full) => { got = full }, (r) => assert.fail(r))
    rx.receive(segmentsBy(wire, n))
    assert.deepEqual(cborCodec.decode(got), msg, `每 ${n} 字节一个 Uint8Array`)
    assert.notEqual(got.buffer, wire.buffer, '跨多个 Uint8Array 只能拷贝')
  }
})

test('快速路径：帧头本身跨多个 Uint8Array 也能读', () => {
  const msg = aMsg({ n: 1 })
  const [frame] = framesOf(cborCodec.encode(msg), 1024)
  const wire = flat(frame)
  let got
  const rx = makeFrameReceiver((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
  rx.receive([wire.subarray(0, 5), wire.subarray(5, 20), wire.subarray(20)])
  assert.deepEqual(got, msg)
})

test('快速路径：空包交出 0 字节', () => {
  const [frame] = framesOf(new Uint8Array(0), 1024)
  const got = []
  const rx = makeFrameReceiver((full) => got.push(full), (r) => assert.fail(r))
  rx.receive(frame)
  rx.receive([flat(frame)])
  assert.equal(got.length, 2)
  for (const full of got) assert.equal(full.length, 0)
})

test('快速路径不绕过重叠检查：同 msgId 在重组中时，完整的单帧仍走重组并被拒', () => {
  const msgId = new Uint8Array(16).fill(7)
  const half = [packFrameHeader(msgId, 0, 20, 10), new Uint8Array(10)]
  const whole = [packFrameHeader(msgId, 0, 20, 20), new Uint8Array(20)]

  const errs = []
  const rx = makeFrameReceiver(() => assert.fail('不该完成'), (r) => errs.push(r))
  rx.receive(half)
  rx.receive(whole)
  assert.deepEqual(errs, ['overlapping-frame'])
  rx.clear()
})

test('快速路径无状态：同一个单帧包的帧来两次就交两次', () => {
  const [frame] = framesOf(cborCodec.encode(aMsg({ n: 1 })), 1024)
  let done = 0
  const rx = makeFrameReceiver(() => done++, (r) => assert.fail(r))
  rx.receive(frame)
  rx.receive(frame)
  assert.equal(done, 2)
})

test('快速路径与重组路径结果逐字节一致（固定种子随机）', () => {
  let seed = 42
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n }
  for (let round = 0; round < 200; round++) {
    const bytes = new Uint8Array(rand(5000))
    for (let i = 0; i < bytes.length; i++) bytes[i] = rand(256)
    const [frame] = framesOf(bytes, bytes.length + FRAME_HEADER_SIZE)
    const wire = flat(frame)

    let fast
    makeFrameReceiver((full) => { fast = Uint8Array.from(full) }, (r) => assert.fail(r))
      .receive(segmentsBy(wire, 1 + rand(wire.length)))

    let slow
    const reasm = makeReassembler((full) => { slow = full }, (r) => assert.fail(r))
    const id = toHex(frame[0].subarray(0, 16))
    reasm.ensure(id, bytes.length).set(frame[1], 0)
    reasm.advance(id, 0, bytes.length)

    assert.deepEqual(fast, slow, `round ${round}, ${bytes.length} bytes`)
    assert.deepEqual(fast, bytes)
  }
})

test('多帧包：顺序、倒序、每帧拆成多个 Uint8Array 都能重组', () => {
  const msg = aMsg({ blob: 'm'.repeat(10 * 1024) })
  const frames = framesOf(cborCodec.encode(msg), 512)
  assert.ok(frames.length > 10)

  for (const [name, order] of [['顺序', frames], ['倒序', [...frames].reverse()]]) {
    for (const n of [0, 3, 33]) {
      let got = null
      const rx = makeFrameReceiver((full) => { got = cborCodec.decode(full) }, (r) => assert.fail(r))
      for (const frame of order) rx.receive(n ? segmentsBy(flat(frame), n) : frame)
      assert.deepEqual(got, msg, `${name}，${n ? `每 ${n} 字节一个 Uint8Array` : '[header, body]'}`)
    }
  }
})

test('多帧包：两个包的帧交错，各自重组', () => {
  const m1 = aMsg({ tag: 'one', blob: 'a'.repeat(3000) })
  const m2 = aMsg({ tag: 'two', blob: 'b'.repeat(3000) })
  const f1 = framesOf(cborCodec.encode(m1), 512), f2 = framesOf(cborCodec.encode(m2), 512)
  const done = []
  const rx = makeFrameReceiver((full) => done.push(cborCodec.decode(full).payload.tag), (r) => assert.fail(r))
  for (let i = 0; i < Math.max(f1.length, f2.length); i++) { f1[i] && rx.receive(f1[i]); f2[i] && rx.receive(f2[i]) }
  assert.deepEqual(done.sort(), ['one', 'two'])
})

test('坏帧抛 NACTError（inbound）：太短 / 版本 / magic / 超上限 / 长度不符', () => {
  const good = flat(framesOf(cborCodec.encode(aMsg({ n: 1 })), 1024)[0])
  const mutate = (fn) => { const f = Uint8Array.from(good); fn(f, new DataView(f.buffer)); return f }
  const cases = [
    ['frame-too-small', good.subarray(0, FRAME_HEADER_SIZE - 1)],
    ['version-mismatch', mutate((f) => { f[31] = 99; f[30] = 0 })],
    ['bad-magic', mutate((f) => { f[30] = 0 })],
    ['frame-too-large', mutate((_, dv) => dv.setUint32(24, MAX_FRAME_SIZE + 1))],
    ['frame-size-mismatch', mutate((_, dv) => dv.setUint32(24, good.length + 1))],
    ['frame-size-mismatch', good.subarray(0, good.length - 1)],
  ]
  for (const [code, frame] of cases) {
    const rx = makeFrameReceiver(() => assert.fail('不该交付'), (r) => assert.fail(r))
    assert.throws(() => rx.receive([frame]), (e) => {
      assert.ok(e instanceof NACTError, code)
      assert.equal(e.code, code)
      assert.equal(e.layer, 'NACT')
      assert.equal(e.phase, 'inbound')
      return true
    })
  }
})

test('越界的帧走 onError，不抛 RangeError', () => {
  const msgId = new Uint8Array(16).fill(9)
  const errs = []
  const rx = makeFrameReceiver(() => assert.fail('不该完成'), (r) => errs.push(r))

  rx.receive([packFrameHeader(msgId, 80, 100, 40), new Uint8Array(40)])     // 80+40 > 100
  assert.deepEqual(errs, ['frame-out-of-bounds'])

  rx.receive([packFrameHeader(msgId, 0, 100, 10), new Uint8Array(10)])      // start reassembly, buffer 100
  rx.receive([packFrameHeader(msgId, 90, 1000, 20), new Uint8Array(20)])    // header claims 1000, buffer is 100
  assert.deepEqual(errs, ['frame-out-of-bounds', 'frame-out-of-bounds'])
  rx.clear()
})

// ── byte-stream frame splitting (nact-provider-shared) ──

test('切帧：任意分块都切出与发送侧相同的帧', () => {
  const frames = [
    ...framesOf(cborCodec.encode(aMsg({ n: 1 })), 512),
    ...framesOf(cborCodec.encode(aMsg({ n: 2, blob: 'x'.repeat(4000) })), 512),
    ...framesOf(new Uint8Array(0), 512),
  ]
  const all = flat(frames.map(flat))

  for (const n of [1, 3, 31, 32, 33, 512, 1000, all.length, all.length * 2]) {
    const out = []
    const push = makeFrameSplitter((frame) => out.push(flat(frame)), (e) => assert.fail(e.message))
    for (const chunk of segmentsBy(all, n)) push(chunk)
    assert.deepEqual(out, frames.map(flat), `每 ${n} 字节一块`)
  }
})

test('切帧：整帧落在一个 chunk 内时，交出的是原 chunk 的 subarray', () => {
  const [a] = framesOf(cborCodec.encode(aMsg({ n: 1 })), 1024)
  const [b] = framesOf(cborCodec.encode(aMsg({ n: 2 })), 1024)
  const chunk = flat([...a, ...b])
  const out = []
  makeFrameSplitter((frame) => out.push(frame), (e) => assert.fail(e.message))(chunk)
  assert.equal(out.length, 2, '一个 chunk 里两帧，切出两次')
  for (const frame of out) {
    assert.equal(frame.length, 1)
    assert.equal(frame[0].buffer, chunk.buffer, '零拷贝')
  }
})

test('切帧：跨 chunk 的帧由多个 Uint8Array 组成，都指向原 chunk', () => {
  const [frame] = framesOf(cborCodec.encode(aMsg({ blob: 'y'.repeat(3000) })), 1024 * 1024)
  const wire = flat(frame)
  const chunks = segmentsBy(wire, 100)
  const out = []
  const push = makeFrameSplitter((f) => out.push(f), (e) => assert.fail(e.message))
  for (const c of chunks) push(c)
  assert.equal(out.length, 1)
  assert.equal(out[0].length, chunks.length)
  out[0].forEach((segment, i) => assert.equal(segment.buffer, chunks[i].buffer))
})

test('切帧 + 逐帧接收：TCP 任意分块端到端还原多个包', () => {
  const msgs = [aMsg({ n: 1 }), aMsg({ n: 2, blob: 'x'.repeat(8000) }), aMsg({ n: 3 })]
  const all = flat(msgs.flatMap(m => framesOf(cborCodec.encode(m), 512)).map(flat))
  for (const n of [1, 7, 512, 9999]) {
    const got = []
    const rx = makeFrameReceiver((full) => got.push(cborCodec.decode(full).payload.n), (r) => assert.fail(r))
    const push = makeFrameSplitter((frame) => rx.receive(frame), (e) => assert.fail(e.message))
    for (const chunk of segmentsBy(all, n)) push(chunk)
    assert.deepEqual(got, [1, 2, 3], `每 ${n} 字节一块`)
  }
})

test('切帧：坏头报一次错，之后的输入全部丢弃', () => {
  const good = flat(framesOf(cborCodec.encode(aMsg({ n: 1 })), 1024)[0])
  const bad = Uint8Array.from(good); bad[31] = 99
  const errs = []
  const push = makeFrameSplitter(() => assert.fail('不该切出帧'), (e) => errs.push(e.code))
  push(bad)
  push(good)
  push(good)
  assert.deepEqual(errs, ['version-mismatch'])
})

test('readFrameSize：先版本、再 magic、再长度', () => {
  const h = packFrameHeader(new Uint8Array(16), 0, 10, 10)
  const code = (f) => { try { readFrameSize(f); return null } catch (e) { return e.code } }
  const mk = (fn) => { const f = Uint8Array.from(h); fn(f, new DataView(f.buffer)); return f }

  assert.equal(readFrameSize(h), FRAME_HEADER_SIZE + 10)
  assert.equal(code(mk((f) => { f[31] = 99; f[30] = 0 })), 'version-mismatch', '版本不认就不谈 magic')
  assert.equal(code(mk((f) => { f[30] = 0 })), 'bad-magic')
  assert.equal(code(mk((_, dv) => dv.setUint32(24, FRAME_HEADER_SIZE - 1))), 'frame-too-small')
  assert.equal(code(mk((_, dv) => dv.setUint32(24, MAX_FRAME_SIZE + 1))), 'frame-too-large')
  assert.equal(code(h.subarray(0, 31)), 'frame-too-small')
})

test('nact-provider-shared 的头布局与 core 一致', () => {
  assert.equal(FRAME_HEADER_SIZE, SHARED_FRAME_HEADER_SIZE, 'shared 与 core 的帧头大小一致')
  for (const [version, magic] of Object.entries(MAGIC_BY_VERSION)) {
    const h = packFrameHeader(new Uint8Array(16), 0, 0, 0)
    h[31] = Number(version); h[30] = magic
    assert.equal(readFrameSize(h), FRAME_HEADER_SIZE, `v${version}`)
  }
})

test('越界的帧被拒（offset+len 超出 totalSize）', () => {
  const errs = []
  const reasm = makeReassembler(() => assert.fail('不该完成'), (r) => errs.push(r))
  reasm.ensure('b', 100)
  reasm.advance('b', 80, 40)          // 80+40 > 100
  assert.deepEqual(errs, ['frame-out-of-bounds'])
})

// ── constants ──

test('默认值都在合理范围', () => {
  assert.equal(FRAME_HEADER_SIZE, 32)
  assert.equal(MAX_FRAME_SIZE, 2 * 1024 * 1024 * 1024)
  for (const t of ['tcp', 'unix', 'websocket']) {
    assert.ok(DEFAULT_CHUNK[t] > FRAME_HEADER_SIZE, `${t} 的默认 chunk 大于头`)
  }
})

test('当前版本在 magic 表里，且 packFrameHeader 写的就是表里那个', () => {
  assert.ok(NACT_VERSION in MAGIC_BY_VERSION, `v${NACT_VERSION} 有对应 magic`)
  const h = packFrameHeader(new Uint8Array(16), 0, 10, 0)
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  assert.equal(dv.getUint8(30), MAGIC_BY_VERSION[NACT_VERSION], 'magic 取自版本表而不是写死')
})

// ── real carrier ──

test('peer 表：连上入表、断开离表，disconnect 只报一次且带走的是那个 peerId', async () => {
  const spec = tcp(PORT.nact)
  const { srv, cli, stop } = await startPair(spec)

  assert.equal(srv.nact.listPeerId().length, 1, '服务端有一个 peer')
  assert.equal(cli.nact.listPeerId().length, 1)

  const peerId = srv.nact.listPeerId()[0]
  const announced = []
  srv.bus.listen(NACTEvent.peerDisconnect, (p) => announced.push(p.peerId))

  await cli.disconnect('srv')
  await sleep(60)

  assert.equal(announced.length, 1, `断开只announce一次，实得 ${announced.length}`)
  assert.equal(announced[0], peerId, 'payload 里是具体走掉的那个 peerId，不是随便一个')
  assert.equal(srv.nact.listPeerId().length, 0, '服务端 peer 表清空')

  await stop()
})

test('connect 事件：入表和 announce 是同一件事', async () => {
  const spec = tcp(PORT.nact + 12)
  const { app: srv, stop: stopSrv } = await startApp('srv', { server: [spec] })

  // subscribe before the peer dials in, or connect fires before the subscription
  const seen = []
  srv.bus.listen(NACTEvent.peerConnect, (p) => seen.push(p.peerId))

  const { app: cli, stop: stopCli } = await startApp('cli')
  await cli.connect('srv', spec)
  await sleep(60)

  assert.equal(seen.length, 1, '一条连接 announce 一次')
  assert.deepEqual(seen, srv.nact.listPeerId(), 'announce 的 peerId 就是表里那个')

  await stopCli(); await stopSrv()
})

test('closePeer 的 resolve 是等 disconnect 事件等来的', async () => {
  const spec = tcp(PORT.nactWs)
  const { cli, stop } = await startPair(spec)

  const peerId = cli.nact.listPeerId()[0]
  // closePeer settles by subscribing to peerDisconnect, so the event always precedes resolve
  let announcedAt = -1, n = 0
  cli.bus.listen(NACTEvent.peerDisconnect, (p) => { if (p.peerId === peerId) announcedAt = ++n })

  assert.equal(await cli.nact.closePeer(peerId), true)
  assert.equal(announcedAt, 1, 'resolve 时 disconnect 已经播过了')
  assert.equal(cli.nact.getPeer(peerId), undefined, 'resolve 后表里已经没有它')
  assert.equal(cli.nact.closePeer(peerId) instanceof Promise, true, '没这个 peer 也返 Promise，不是 undefined')
  assert.equal(await cli.nact.closePeer(peerId), false, '再关一次返 false')

  await stop()
})

test('sendToPeer：找到就 true，找不到就 false', async () => {
  const spec = tcp(PORT.nact + 13)
  const { cli, stop } = await startPair(spec)

  assert.equal(await cli.nact.sendToPeer('不存在的 peer', aMsg({})), false)
  assert.equal(await cli.nact.sendToPeer(cli.nact.listPeerId()[0], aMsg({})), true, '真 peer 上返 true')

  await stop()
})

test('addPeer / getPeer / dropPeer / listPeerId 是一套自洽的表操作', async () => {
  const { app, stop } = await startApp('table')
  const fake = { id: 'p-手搓', async send() {}, close() {} }

  assert.equal(app.nact.getPeer('p-手搓'), undefined, '还没加')
  app.nact.addPeer(fake)
  assert.equal(app.nact.getPeer('p-手搓'), fake, 'getPeer 拿回同一个对象')
  assert.deepEqual(app.nact.listPeerId(), ['p-手搓'])

  assert.equal(app.nact.dropPeer('p-手搓'), true, '真删掉了返 true')
  assert.equal(app.nact.dropPeer('p-手搓'), false, '重复 drop 可见，不静默')
  assert.deepEqual(app.nact.listPeerId(), [])

  // addPeer keyed by peer.id: re-adding the same id replaces, never coexists
  const dupA = { id: 'dup', async send() {}, close() {} }
  const dupB = { id: 'dup', async send() {}, close() {} }
  app.nact.addPeer(dupA)
  app.nact.addPeer(dupB)
  assert.equal(app.nact.listPeerId().length, 1, '同 id 只有一行')
  assert.equal(app.nact.getPeer('dup'), dupB, '后加的那个赢')

  await stop()
})

test('listen 的 onPeer 拿到的 peer 已经在表里了', async () => {
  const spec = tcp(PORT.nact + 14)
  const { app: srv, stop: stopSrv } = await startApp('srv')

  const handed = []
  const handle = await srv.nact.listen(spec, (peer) => handed.push(peer))

  const { app: cli, stop: stopCli } = await startApp('cli')
  await cli.connect('srv', spec)
  await sleep(60)

  assert.equal(handed.length, 1, 'onPeer 收到这条连接')
  assert.equal(srv.nact.getPeer(handed[0].id), handed[0], '交到 onPeer 手上时已入表 —— 握手不用自己补登记')
  assert.equal(typeof handle.close, 'function', 'listen 返回的 handle 能关')

  await stopCli(); await stopSrv()
})

test('terminate：peer 表清空、且teardown 期间不播 disconnect', async () => {
  const spec = tcp(PORT.nact + 15)
  const { app: srv, stop: stopSrv } = await startApp('srv', { server: [spec] })
  const { app: cli } = await startApp('cli')
  await cli.connect('srv', spec)
  await sleep(60)
  assert.equal(srv.nact.listPeerId().length, 1)

  const announced = []
  srv.bus.listen(NACTEvent.peerDisconnect, (p) => announced.push(p.peerId))

  await srv.nact.terminate()
  await sleep(80)                       // let the socket close event arrive

  assert.equal(srv.nact.listPeerId().length, 0, '整层 teardown 后表是空的')
  assert.equal(announced.length, 0,
    `terminate 是安静的：表先清空，socket 的 close 到达时 gone 找不到行可删，就不 announce。实得 ${announced.length} 条`)

  await stopSrv()
})

test('自定义 chunkSize 生效：小 chunk 迫使大量帧，消息仍完整', async () => {
  const spec = tcp(PORT.nact + 7, { chunkSize: 512 })
  const { cli, stop } = await startPair(spec)
  const big = 'C'.repeat(60 * 1024)     // 512-byte frames → 120+ frames
  const res = await cli.request('srv', { kind: 'ability', target: 'echo', payload: { big } }).response
  assert.equal(res.payload.big, big)
  await stop()
})
