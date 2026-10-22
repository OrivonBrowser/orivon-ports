// CIDs for the IPFS modules: unsigned varints, base32 and base58btc, and the
// CIDv1 / CIDv0 forms of a sha2-256 content address. Plain JavaScript with no
// dependencies, so it runs unchanged in a browser page and in Node.

export const DAG_PB = 0x70
export const RAW = 0x55
export const SHA2_256 = 0x12

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const MAX_VARINT_BYTES = 9

/**
 * @typedef {object} Cid
 * @property {number} version the version the input was written in (0 or 1)
 * @property {number} codec multicodec of the block
 * @property {number} hashCode multihash function code
 * @property {Uint8Array} digest the hash digest
 * @property {Uint8Array} bytes the CIDv1 binary form, whatever the input version
 * @property {string} string the CIDv1 base32 form, whatever the input version
 */

/** @param {number} value @returns {Uint8Array} */
export function encodeVarint (value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`cannot encode ${value} as a varint`)
  const out = []
  let rest = value
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  out.push(rest)
  return Uint8Array.from(out)
}

/** @param {Uint8Array} bytes @param {number} [offset] @returns {{ value: number, length: number }} */
export function decodeVarint (bytes, offset = 0) {
  let value = 0
  let scale = 1
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    const byte = bytes[offset + i]
    if (byte === undefined) throw new Error('truncated varint')
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return { value, length: i + 1 }
    scale *= 0x80
  }
  throw new Error('varint too long')
}

/** @param {Uint8Array[]} parts */
export function concatBytes (parts) {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** @param {Uint8Array} a @param {Uint8Array} b */
export function bytesEqual (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** RFC 4648 base32, lowercase, no padding. @param {Uint8Array} bytes */
export function base32Encode (bytes) {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
  return out
}

/** @param {string} text @returns {Uint8Array} */
export function base32Decode (text) {
  const out = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = BASE32.indexOf(char)
    if (value < 0) throw new Error(`invalid base32 character ${JSON.stringify(char)}`)
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
    buffer &= (1 << bits) - 1
  }
  if (buffer !== 0) throw new Error('base32 has non-zero trailing bits')
  return Uint8Array.from(out)
}

/** @param {string} text @returns {Uint8Array} */
export function base58Decode (text) {
  /** @type {number[]} */
  const digits = []
  for (const char of text) {
    const value = BASE58.indexOf(char)
    if (value < 0) throw new Error(`invalid base58 character ${JSON.stringify(char)}`)
    let carry = value
    for (let i = 0; i < digits.length; i++) {
      carry += /** @type {number} */ (digits[i]) * 58
      digits[i] = carry & 255
      carry >>= 8
    }
    while (carry > 0) {
      digits.push(carry & 255)
      carry >>= 8
    }
  }
  let zeros = 0
  while (zeros < text.length && text[zeros] === '1') zeros++
  return Uint8Array.from([...new Array(zeros).fill(0), ...digits.reverse()])
}

/** The CIDv1 binary form of a sha2-256 digest. */
function cidV1Bytes (codec, hashCode, digest) {
  return concatBytes([
    encodeVarint(1), encodeVarint(codec), encodeVarint(hashCode), encodeVarint(digest.length), digest
  ])
}

/** @param {number} version @param {number} codec @param {number} hashCode @param {Uint8Array} digest @returns {Cid} */
function makeCid (version, codec, hashCode, digest) {
  const bytes = cidV1Bytes(codec, hashCode, digest)
  return { version, codec, hashCode, digest, bytes, string: 'b' + base32Encode(bytes) }
}

/**
 * Reads one binary CID (CIDv1 or the bare CIDv0 multihash) from `bytes` at
 * `offset`; `length` is how many bytes it took.
 * @param {Uint8Array} bytes @param {number} [offset]
 * @returns {{ cid: Cid, length: number }}
 */
export function readCidBytes (bytes, offset = 0) {
  if (bytes[offset] === SHA2_256 && bytes[offset + 1] === 32) {
    if (bytes.length < offset + 34) throw new Error('truncated CIDv0')
    return { cid: makeCid(0, DAG_PB, SHA2_256, bytes.slice(offset + 2, offset + 34)), length: 34 }
  }
  let at = offset
  const version = decodeVarint(bytes, at)
  at += version.length
  if (version.value !== 1) throw new Error(`unsupported CID version ${version.value}`)
  const codec = decodeVarint(bytes, at)
  at += codec.length
  const hashCode = decodeVarint(bytes, at)
  at += hashCode.length
  const size = decodeVarint(bytes, at)
  at += size.length
  if (bytes.length < at + size.value) throw new Error('truncated CID digest')
  const digest = bytes.slice(at, at + size.value)
  return { cid: makeCid(1, codec.value, hashCode.value, digest), length: at + size.value - offset }
}

/**
 * Parses a CIDv1 base32 string (`b...`) or a CIDv0 string (`Qm...`).
 * @param {string} text
 * @returns {Cid}
 */
export function parseCid (text) {
  if (typeof text !== 'string') throw new Error('a CID must be a string')
  if (text.length === 46 && text.startsWith('Qm')) {
    const bytes = base58Decode(text)
    if (bytes.length !== 34 || bytes[0] !== SHA2_256 || bytes[1] !== 32) throw new Error(`not a CIDv0: ${text}`)
    return readCidBytes(bytes).cid
  }
  if (text.startsWith('b')) {
    const bytes = base32Decode(text.slice(1))
    const { cid, length } = readCidBytes(bytes)
    if (length !== bytes.length) throw new Error(`trailing bytes after the CID: ${text}`)
    return cid
  }
  throw new Error(`unsupported CID: ${text.slice(0, 12)}`)
}

/** The CIDv1 (sha2-256) of a block. @param {number} codec @param {Uint8Array} bytes @returns {Promise<Cid>} */
export async function cidFor (codec, bytes) {
  return makeCid(1, codec, SHA2_256, await sha256(bytes))
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} */
export async function sha256 (bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes)))
}
