// The wire protocol `orivon-share/1`, on one ordered, reliable data channel between two Share pages. A request names
// a block of the share; the answer is its bytes, or `none`. A message is cut into frames of at most 64 KiB (a block
// of 256 KiB is more than Chromium sends as one SCTP message) and put back together, and a sender waits whenever the
// channel's buffer is full, so a slow peer slows the sender instead of filling its memory.

import { readCidBytes } from '../ipfs/cid.js'

export const FRAME_BYTES = 64 * 1024
export const VERSION = 1
const HEADER_BYTES = 5
const FIN = 1
const HELLO = 0
const REQUEST = 1
const BLOCK = 2
const NONE = 3
/** A message longer than this is not a block of a UnixFS file. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024 + 64
const MAX_ASSEMBLING = 16
const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024
export const REQUEST_TIMEOUT_MS = 20_000

/**
 * What a data channel gives. A fake of this is how the protocol is tested.
 * @typedef {object} ChannelLike
 * @property {string} readyState
 * @property {number} bufferedAmount
 * @property {number} bufferedAmountLowThreshold
 * @property {string} [binaryType]
 * @property {(data: Uint8Array) => void} send
 * @property {() => void} close
 * @property {(type: 'message' | 'close' | 'error' | 'bufferedamountlow', listener: (event: any) => void, options?: { once?: boolean }) => void} addEventListener
 * @typedef {object} LinkHandlers
 * @property {(cid: string) => Promise<Uint8Array | null>} [onRequest] answers a request for a block (a seeder)
 * @property {number} [maxInFlight] requests a peer may have waiting at once; more ends the link
 * @property {() => void} [onClose]
 */

/** @param {number} value @returns {Uint8Array} */
function u32 (value) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0)
  return out
}

/** @param {ChannelLike} channel @param {LinkHandlers} [handlers] */
export function createLink (channel, handlers = {}) {
  channel.binaryType = 'arraybuffer'
  channel.bufferedAmountLowThreshold = LOW_WATER
  /** @type {Map<number, { resolve: (bytes: Uint8Array | null) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map()
  /** @type {Map<number, Uint8Array[]>} */
  const assembling = new Map()
  /** @type {Map<number, number>} */
  const assembledBytes = new Map()
  let nextRequest = 1
  let nextMessage = 1
  let closed = false
  let helloSeen = false
  let inFlightAnswers = 0
  /** @type {Promise<void>} */
  let queue = Promise.resolve()
  const link = {
    uploaded: 0,
    downloaded: 0,
    get open () { return !closed },
    get ready () { return helloSeen },

    /** Asks the peer for a block. Resolves with its bytes, or null when the peer does not have it. @param {Uint8Array} cidBytes @param {number} [timeoutMs] @returns {Promise<Uint8Array | null>} */
    request (cidBytes, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error('The connection to the peer is closed.'))
      const id = nextRequest++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The peer did not answer in time.')) }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        send(REQUEST, u32(id), cidBytes).catch((error) => { clearTimeout(timer); pending.delete(id); reject(error) })
      })
    },

    close () {
      if (closed) return
      closed = true
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('The connection to the peer closed.')) }
      pending.clear()
      assembling.clear()
      try { channel.close() } catch { /* already closed */ }
      handlers.onClose?.()
    }
  }

  /** Sends one message as frames, one message at a time. @param {number} type @param {Uint8Array[]} parts @returns {Promise<void>} */
  function send (type, ...parts) {
    const message = new Blob([Uint8Array.of(type), ...parts.map((part) => /** @type {BlobPart} */ (part))])
    const run = async () => {
      if (closed) throw new Error('The connection to the peer is closed.')
      const bytes = new Uint8Array(await message.arrayBuffer())
      const id = nextMessage++
      for (let at = 0; at === 0 || at < bytes.length; at += FRAME_BYTES - HEADER_BYTES) {
        const chunk = bytes.subarray(at, at + FRAME_BYTES - HEADER_BYTES)
        const frame = new Uint8Array(HEADER_BYTES + chunk.length)
        frame[0] = at + chunk.length >= bytes.length ? FIN : 0
        frame.set(u32(id), 1)
        frame.set(chunk, HEADER_BYTES)
        if (channel.bufferedAmount > HIGH_WATER) await new Promise((resolve) => { channel.addEventListener('bufferedamountlow', resolve, { once: true }) })
        if (closed) throw new Error('The connection to the peer is closed.')
        channel.send(frame)
        if (type === BLOCK) link.uploaded += chunk.length
      }
    }
    const result = queue.then(run)
    queue = result.catch(() => {})
    return result
  }

  /** @param {Uint8Array} message */
  function handle (message) {
    const type = message[0]
    if (type === HELLO) {
      if (message[1] !== VERSION) link.close()
      else helloSeen = true
      return
    }
    if (message.length < 5) { link.close(); return }
    const id = new DataView(message.buffer, message.byteOffset, message.byteLength).getUint32(1)
    if (type === REQUEST) {
      const asked = handlers.onRequest
      if (asked === undefined || inFlightAnswers >= (handlers.maxInFlight ?? 32)) { link.close(); return }
      let cid
      try {
        const parsed = readCidBytes(message.subarray(5), 0)
        if (parsed.length !== message.length - 5) throw new Error('trailing bytes')
        cid = parsed.cid.string
      } catch {
        link.close()
        return
      }
      inFlightAnswers += 1
      asked(cid).then((bytes) => bytes === null ? send(NONE, u32(id)) : send(BLOCK, u32(id), bytes), () => send(NONE, u32(id)))
        .catch(() => {}).finally(() => { inFlightAnswers -= 1 })
      return
    }
    const waiting = pending.get(id)
    if (waiting === undefined) return
    clearTimeout(waiting.timer)
    pending.delete(id)
    if (type === BLOCK) {
      link.downloaded += message.length - 5
      waiting.resolve(message.slice(5))
    } else if (type === NONE) waiting.resolve(null)
    else link.close()
  }

  channel.addEventListener('message', (event) => {
    if (closed) return
    const data = event.data
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) { link.close(); return }
    const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    if (frame.length < HEADER_BYTES || frame.length > FRAME_BYTES) { link.close(); return }
    const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1)
    const chunks = assembling.get(id) ?? []
    if (assembling.size >= MAX_ASSEMBLING && !assembling.has(id)) { link.close(); return }
    const total = (assembledBytes.get(id) ?? 0) + frame.length - HEADER_BYTES
    if (total > MAX_MESSAGE_BYTES) { link.close(); return }
    chunks.push(frame.slice(HEADER_BYTES))
    if ((frame[0] ?? 0) & FIN) {
      assembling.delete(id)
      assembledBytes.delete(id)
      const message = new Uint8Array(total)
      let at = 0
      for (const chunk of chunks) { message.set(chunk, at); at += chunk.length }
      if (message.length > 0) handle(message)
    } else {
      assembling.set(id, chunks)
      assembledBytes.set(id, total)
    }
  })
  channel.addEventListener('close', () => link.close())
  channel.addEventListener('error', () => link.close())
  send(HELLO, Uint8Array.of(VERSION)).catch(() => link.close())
  return link
}
