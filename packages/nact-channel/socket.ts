import type { Socket } from 'node:net'
import type { TransportChannel } from '@chenyfan/nasdk/NACT'
import { transportError } from './index.ts'

/** Shared TCP/Unix adapter; bytes wait until a consumer attaches. */
export class SocketChannel implements TransportChannel {
  private mode?: 'callback' | 'iterator'
  constructor(private socket: Socket) {
    socket.pause(); socket.setNoDelay(true)
    // Keep a sink during teardown after NACT detaches its observers.
    socket.on('error', () => {})
  }
  send(chunks: readonly Uint8Array[]): Promise<void> {
    if (this.socket.destroyed || this.socket.writableEnded) return Promise.reject(transportError('transport-closed'))
    return new Promise((resolve, reject) => {
      let pending = chunks.length
      if (!pending) { resolve(); return }
      this.socket.cork()
      try {
        for (const chunk of chunks) this.socket.write(chunk, error => {
          if (error) reject(error)
          else if (--pending === 0) resolve()
        })
      } finally { this.socket.uncork() }
    })
  }
  close() { this.socket.end() }
  terminate() { this.socket.destroy() }
  onReceive(handler: (bytes: Uint8Array) => void) {
    this.lock('callback'); this.socket.on('data', handler); this.socket.resume()
    return () => { this.socket.off('data', handler) }
  }
  onClose(handler: () => void) {
    this.socket.on('close', handler)
    return () => { this.socket.off('close', handler) }
  }
  onError(handler: (reason: unknown) => void) {
    this.socket.on('error', handler)
    return () => { this.socket.off('error', handler) }
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    this.lock('iterator')
    return this.socket[Symbol.asyncIterator]()
  }
  private lock(mode: 'callback' | 'iterator') {
    if (this.mode && (this.mode !== mode || mode === 'iterator')) throw transportError('receive-mode-conflict')
    this.mode = mode
  }
}
