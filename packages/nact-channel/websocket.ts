import { ByteChannel, transportError } from './index.ts'

export interface WebSocketLike {
  binaryType: BinaryType
  readonly readyState: number
  readonly bufferedAmount: number
  send(bytes: Uint8Array): void
  close(): void
  terminate?(): void
  addEventListener(type: string, handler: (event: any) => void): void
  removeEventListener(type: string, handler: (event: any) => void): void
  on?(type: string, handler: (...args: any[]) => void): void
  off?(type: string, handler: (...args: any[]) => void): void
}

/** Works with browser WebSocket and ws; shares callback/iterator validation and bounds. */
export function webSocketChannel(socket: WebSocketLike, maxBufferedBytes = 4 * 1024 * 1024) {
  socket.binaryType = 'arraybuffer'
  const channel = new ByteChannel({
    send: chunks => {
      if (socket.readyState !== 1) throw transportError('transport-closed')
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      if (socket.bufferedAmount + size > maxBufferedBytes) throw transportError('send-buffer-overflow')
      const frame = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { frame.set(chunk, offset); offset += chunk.byteLength }
      socket.send(frame)
    },
    close: () => {
      socket.close()
    },
  }, maxBufferedBytes)
  const message = (event: MessageEvent) => {
    if (event.data instanceof ArrayBuffer) channel.receive(new Uint8Array(event.data))
    else if (ArrayBuffer.isView(event.data)) channel.receive(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength))
    else channel.fail(transportError('non-binary-frame'))
  }
  const rawMessage = (data: unknown, binary: boolean) => {
    if (!binary) channel.fail(transportError('non-binary-frame'))
    else message({ data } as MessageEvent)
  }
  const error = () => channel.fail(transportError('websocket-error'))
  const close = () => { channel.end(); cleanup() }
  const cleanup = () => {
    if (socket.on && socket.off) socket.off('message', rawMessage)
    else socket.removeEventListener('message', message)
    socket.removeEventListener('error', error)
    socket.removeEventListener('close', close)
  }
  if (socket.on && socket.off) socket.on('message', rawMessage)
  else socket.addEventListener('message', message)
  socket.addEventListener('error', error)
  socket.addEventListener('close', close)
  channel.terminate = () => {
    if (socket.terminate) socket.terminate()
    else socket.close()
    channel.end()
  }
  if (socket.readyState > 1) { channel.end(); cleanup() }
  return channel
}
