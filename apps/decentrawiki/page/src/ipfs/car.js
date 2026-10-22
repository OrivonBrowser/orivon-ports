// CARv1: a writer, and a reader that checks every block against its CID. The
// header is the small dag-cbor map `{ roots: [CID], version: 1 }`, written and
// read by hand.

import { SHA2_256, bytesEqual, concatBytes, decodeVarint, encodeVarint, parseCid, readCidBytes, sha256 } from './cid.js'

export { listDirectory, readPath } from './dagread.js'

const CBOR_TAG_CID = 42
const MAX_HEADER_BYTES = 1 << 20

/** @param {number} major @param {number} value */
function cborHead (major, value) {
  if (value < 24) return Uint8Array.of((major << 5) | value)
  if (value < 256) return Uint8Array.of((major << 5) | 24, value)
  if (value < 65536) return Uint8Array.of((major << 5) | 25, value >> 8, value & 255)
  throw new Error('CBOR value too large for a CAR header')
}

/** @param {string} text */
function cborText (text) {
  const bytes = new TextEncoder().encode(text)
  return concatBytes([cborHead(3, bytes.length), bytes])
}

/** @param {Uint8Array} cidBytes the tagged CID: tag 42 over bytes with a leading 0x00 */
function cborCid (cidBytes) {
  const body = concatBytes([Uint8Array.of(0), cidBytes])
  return concatBytes([cborHead(6, CBOR_TAG_CID), cborHead(2, body.length), body])
}

/**
 * A CARv1 with one root. Sections follow the map's iteration order.
 * @param {string} rootCid @param {Map<string, Uint8Array>} blocks
 * @returns {Uint8Array}
 */
export function writeCar (rootCid, blocks) {
  const header = concatBytes([
    cborHead(5, 2),
    cborText('roots'), cborHead(4, 1), cborCid(parseCid(rootCid).bytes),
    cborText('version'), cborHead(0, 1)
  ])
  const parts = [encodeVarint(header.length), header]
  for (const [cid, data] of blocks) {
    const cidBytes = parseCid(cid).bytes
    parts.push(encodeVarint(cidBytes.length + data.length), cidBytes, data)
  }
  return concatBytes(parts)
}

/**
 * Reads the header map: `roots` (tagged CIDs) and `version` (1).
 * @param {Uint8Array} header @returns {string[]}
 */
function readHeader (header) {
  let at = 0
  /** @returns {{ major: number, value: number }} */
  const head = () => {
    const first = header[at++]
    if (first === undefined) throw new Error('CAR header is truncated')
    const major = first >> 5
    const info = first & 31
    if (info < 24) return { major, value: info }
    const width = info === 24 ? 1 : info === 25 ? 2 : 0
    if (width === 0) throw new Error('CAR header uses an unsupported CBOR encoding')
    let value = 0
    for (let i = 0; i < width; i++) {
      const byte = header[at++]
      if (byte === undefined) throw new Error('CAR header is truncated')
      value = value * 256 + byte
    }
    return { major, value }
  }
  /** @param {number} major */
  const expect = (major) => {
    const item = head()
    if (item.major !== major) throw new Error('CAR header is not the expected CBOR shape')
    return item.value
  }
  const text = () => {
    const size = expect(3)
    const bytes = header.subarray(at, at + size)
    if (bytes.length !== size) throw new Error('CAR header is truncated')
    at += size
    return new TextDecoder().decode(bytes)
  }
  /** @type {string[] | undefined} */
  let roots
  let version
  const entries = expect(5)
  for (let i = 0; i < entries; i++) {
    const key = text()
    if (key === 'version') {
      version = expect(0)
    } else if (key === 'roots') {
      const count = expect(4)
      roots = []
      for (let r = 0; r < count; r++) {
        if (expect(6) !== CBOR_TAG_CID) throw new Error('a CAR root is not a CID')
        const size = expect(2)
        const body = header.subarray(at, at + size)
        if (body.length !== size || body[0] !== 0) throw new Error('a CAR root is malformed')
        at += size
        roots.push(readCidBytes(body, 1).cid.string)
      }
    } else {
      throw new Error(`unexpected CAR header key ${JSON.stringify(key)}`)
    }
  }
  if (version !== 1) throw new Error(`unsupported CAR version ${version}`)
  if (!roots) throw new Error('CAR header has no roots')
  return roots
}

/**
 * Every block of a CARv1, each hashed and compared with its CID. When
 * `expectedRoot` is given the header must list it; a block with another hash
 * function, a bad digest or a cut-off section is an error.
 * @param {Uint8Array} bytes @param {string} [expectedRoot]
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readCar (bytes, expectedRoot) {
  const expected = expectedRoot === undefined ? undefined : parseCid(expectedRoot).string
  const headerSize = decodeVarint(bytes, 0)
  if (headerSize.value === 0 || headerSize.value > MAX_HEADER_BYTES) throw new Error('CAR header has an invalid size')
  let at = headerSize.length
  if (bytes.length < at + headerSize.value) throw new Error('CAR is truncated in its header')
  const roots = readHeader(bytes.subarray(at, at + headerSize.value))
  if (expected !== undefined && !roots.includes(expected)) throw new Error(`CAR roots ${roots.join(', ')} do not include ${expected}`)
  at += headerSize.value

  /** @type {Map<string, Uint8Array>} */
  const blocks = new Map()
  while (at < bytes.length) {
    const size = decodeVarint(bytes, at)
    at += size.length
    if (size.value === 0 || at + size.value > bytes.length) throw new Error('CAR is truncated in a block')
    const end = at + size.value
    const { cid, length } = readCidBytes(bytes.subarray(0, end), at)
    if (cid.hashCode !== SHA2_256 || cid.digest.length !== 32) {
      throw new Error(`block ${cid.string} uses a hash function other than sha2-256`)
    }
    const data = bytes.subarray(at + length, end)
    if (!bytesEqual(await sha256(data), cid.digest)) throw new Error(`block ${cid.string} does not match its CID`)
    blocks.set(cid.string, data)
    at = end
  }
  return blocks
}
