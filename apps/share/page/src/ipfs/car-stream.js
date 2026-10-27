// Reads a CARv1 from a byte stream one section at a time: each block is hashed and compared with its CID before it
// is handed on, and the bytes read are counted against a cap, so a gateway can neither slip in a block nor send
// more than was asked for.

import { SHA2_256, bytesEqual, decodeVarint, parseCid, readCidBytes, sha256 } from './cid.js'
import { MAX_HEADER_BYTES, parseCarHeader } from './car.js'

/** No block of a UnixFS file is larger than this; a trustless gateway sends none above 2 MiB. */
export const MAX_SECTION_BYTES = 4 * 1024 * 1024

export class TooLargeError extends Error {
  /** @param {number} limit */
  constructor (limit) {
    super(`The answer is larger than ${limit} bytes, the most that was asked for.`)
    this.name = 'TooLargeError'
  }
}

class ByteReader {
  /** @param {ReadableStream<Uint8Array>} stream @param {number} maxBytes @param {(total: number) => void} onBytes */
  constructor (stream, maxBytes, onBytes) {
    this.reader = stream.getReader()
    /** @type {Uint8Array[]} */
    this.queue = []
    this.have = 0
    this.total = 0
    this.maxBytes = maxBytes
    this.onBytes = onBytes
  }

  /** The next `n` bytes as one fresh array, or null when the stream ended before any of them. @param {number} n @returns {Promise<Uint8Array | null>} */
  async take (n) {
    while (this.have < n) {
      const { value, done } = await this.reader.read()
      if (done) {
        if (this.have === 0) return null
        throw new Error('The CAR ends in the middle of a block.')
      }
      this.total += value.length
      if (this.total > this.maxBytes) throw new TooLargeError(this.maxBytes)
      this.onBytes(this.total)
      if (value.length > 0) {
        this.queue.push(value)
        this.have += value.length
      }
    }
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const head = /** @type {Uint8Array} */ (this.queue[0])
      const want = n - at
      if (head.length <= want) {
        out.set(head, at)
        at += head.length
        this.queue.shift()
      } else {
        out.set(head.subarray(0, want), at)
        this.queue[0] = head.subarray(want)
        at = n
      }
    }
    this.have -= n
    return out
  }

  /** @returns {Promise<number | null>} */
  async varint() {
    /** @type {number[]} */
    const bytes = []
    for (let i = 0; i < 9; i++) {
      const next = await this.take(1)
      if (next === null) {
        if (i === 0) return null
        throw new Error('The CAR ends in the middle of a length.')
      }
      bytes.push(/** @type {number} */ (next[0]))
      if ((/** @type {number} */ (next[0]) & 0x80) === 0) return decodeVarint(Uint8Array.from(bytes)).value
    }
    throw new Error('The CAR has a length that is too long.')
  }

  cancel () {
    return this.reader.cancel().catch(() => {})
  }
}

/**
 * The verified blocks of a CAR, in the order they come. Stops with an error at the first block that does not match
 * its CID, uses another hash function, or is cut off.
 * @param {ReadableStream<Uint8Array>} body
 * @param {{ expectedRoot?: string, maxBytes?: number, onBytes?: (total: number) => void }} [options]
 * @returns {AsyncGenerator<{ cid: string, data: Uint8Array }>}
 */
export async function * readCarStream (body, { expectedRoot, maxBytes = Infinity, onBytes = () => {} } = {}) {
  const reader = new ByteReader(body, maxBytes, onBytes)
  try {
    const headerSize = await reader.varint()
    if (headerSize === null || headerSize === 0 || headerSize > MAX_HEADER_BYTES) throw new Error('The CAR has an invalid header.')
    const header = await reader.take(headerSize)
    if (header === null) throw new Error('The CAR ends in its header.')
    const roots = parseCarHeader(header)
    if (expectedRoot !== undefined && !roots.includes(parseCid(expectedRoot).string)) throw new Error(`The CAR is for ${roots.join(', ')}, not ${expectedRoot}.`)
    for (;;) {
      const size = await reader.varint()
      if (size === null) return
      if (size === 0 || size > MAX_SECTION_BYTES) throw new Error('The CAR has a block of an invalid size.')
      const section = await reader.take(size)
      if (section === null) throw new Error('The CAR ends in the middle of a block.')
      const { cid, length } = readCidBytes(section, 0)
      if (cid.hashCode !== SHA2_256 || cid.digest.length !== 32) throw new Error(`Block ${cid.string} uses a hash function other than sha2-256.`)
      const data = section.subarray(length)
      if (!bytesEqual(await sha256(data), cid.digest)) throw new Error(`Block ${cid.string} does not match its address.`)
      yield { cid: cid.string, data }
    }
  } finally {
    await reader.cancel()
  }
}
