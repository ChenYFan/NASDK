// NACT frame splitting shared by all providers; header layout must match NACT/framing.ts.

export const FRAME_HEADER_SIZE = 32
export const MAX_FRAME_SIZE = 2 * 1024 * 1024 * 1024
export const NACT_VERSION = 0x01
export const MAGIC_BY_VERSION: Record<number, number> = { 0x01: 0xCF }

export const NACT_PREFACE = new Uint8Array([NACT_VERSION, MAGIC_BY_VERSION[NACT_VERSION]!])

const frameError = (code: string) => Object.assign(new Error(`bad NACT frame: ${code}`), { code })

export function readFrameSize(header: Uint8Array): number {
  if (header.byteLength < FRAME_HEADER_SIZE) throw frameError('frame-too-small')
  const magic = MAGIC_BY_VERSION[header[31]!]
  if (magic === undefined) throw frameError('version-mismatch')
  if (header[30] !== magic) throw frameError('bad-magic')
  const size = new DataView(header.buffer, header.byteOffset, FRAME_HEADER_SIZE).getUint32(24)
  if (size < FRAME_HEADER_SIZE) throw frameError('frame-too-small')
  if (size > MAX_FRAME_SIZE) throw frameError('frame-too-large')
  return size
}

export function makeFrameSplitter(
  onFrame: (frame: readonly Uint8Array[]) => void,
  onError: (reason: Error) => void,
) {
  let pending: Uint8Array[] = []
  let buffered = 0
  let frameSize = 0
  let failed = false
  const header = new Uint8Array(FRAME_HEADER_SIZE)

  const readHeader = () => {
    const first = pending[0]!
    if (first.byteLength >= FRAME_HEADER_SIZE) return readFrameSize(first)
    let at = 0
    for (const chunk of pending) {
      const take = Math.min(chunk.byteLength, FRAME_HEADER_SIZE - at)
      header.set(chunk.subarray(0, take), at)
      at += take
      if (at === FRAME_HEADER_SIZE) break
    }
    return readFrameSize(header)
  }

  return (chunk: Uint8Array) => {
    if (failed || !chunk.byteLength) return
    pending.push(chunk)
    buffered += chunk.byteLength
    while (true) {
      if (!frameSize) {
        if (buffered < FRAME_HEADER_SIZE) return
        try { frameSize = readHeader() } catch (reason) {
          failed = true
          pending = []
          return onError(reason as Error)
        }
      }
      if (buffered < frameSize) return
      const frame: Uint8Array[] = []
      let need = frameSize
      while (need) {
        const head = pending[0]!
        if (head.byteLength <= need) {
          frame.push(head)
          pending.shift()
          need -= head.byteLength
        } else {
          frame.push(head.subarray(0, need))
          pending[0] = head.subarray(need)
          need = 0
        }
      }
      buffered -= frameSize
      frameSize = 0
      onFrame(frame)
      if (failed) return
    }
  }
}
