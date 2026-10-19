// Varints, multibase (base32 and base36, lower case) and CIDs. A CID is parsed into plain
// fields; `cidToString` writes one back in base32 ('b') or base36 ('k').

import { fromHex, toHex } from './bytes.js'

export const CODEC = { dagPb: 0x70, raw: 0x55, libp2pKey: 0x72 }
export const HASH = { identity: 0x00, sha256: 0x12 }

/**
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 * @returns {[number, number]} the value and the offset after it
 */
export function readVarint (bytes, offset = 0) {
  let value = 0
  let scale = 1
  let pos = offset
  for (;;) {
    if (pos >= bytes.length) throw new Error('truncated varint')
    const byte = /** @type {number} */ (bytes[pos++])
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return [value, pos]
    scale *= 128
    if (scale > 2 ** 56) throw new Error('varint too long')
  }
}

/** @param {number} value @returns {number[]} */
export function writeVarint (value) {
  const out = []
  let rest = value
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  out.push(rest)
  return out
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** @param {Uint8Array} bytes */
export function base32Encode (bytes) {
  let out = ''
  let bits = 0
  let acc = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31]
  return out
}

/** @param {string} text */
export function base32Decode (text) {
  const out = []
  let bits = 0
  let acc = 0
  for (const char of text) {
    const value = B32.indexOf(char)
    if (value < 0) throw new Error('not base32')
    acc = (acc << 5) | value
    bits += 5
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff)
      bits -= 8
    }
    acc &= (1 << bits) - 1
  }
  return Uint8Array.from(out)
}

/** @param {Uint8Array} bytes */
export function base36Encode (bytes) {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const rest = bytes.subarray(zeros)
  const digits = rest.length === 0 ? '' : BigInt('0x' + toHex(rest)).toString(36)
  return '0'.repeat(zeros) + digits
}

/** @param {string} text */
export function base36Decode (text) {
  let zeros = 0
  while (zeros < text.length && text[zeros] === '0') zeros++
  let value = 0n
  for (const char of text.slice(zeros)) {
    const digit = B36.indexOf(char)
    if (digit < 0) throw new Error('not base36')
    value = value * 36n + BigInt(digit)
  }
  let hex = value === 0n ? '' : value.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const body = fromHex(hex)
  const out = new Uint8Array(zeros + body.length)
  out.set(body, zeros)
  return out
}

/**
 * @typedef {{ version: number, codec: number, hashCode: number, digest: Uint8Array }} Cid
 */

/**
 * Parses the binary form of a CID, or a bare sha2-256 multihash, which is a CIDv0 and is
 * read as the same dag-pb content.
 * @param {Uint8Array} bytes
 * @returns {Cid}
 */
export function parseCidBytes (bytes) {
  if (bytes.length === 34 && bytes[0] === HASH.sha256 && bytes[1] === 32) {
    return { version: 0, codec: CODEC.dagPb, hashCode: HASH.sha256, digest: bytes.slice(2) }
  }
  const [version, afterVersion] = readVarint(bytes, 0)
  if (version !== 1) throw new Error(`unsupported CID version ${version}`)
  const [codec, afterCodec] = readVarint(bytes, afterVersion)
  const [hashCode, afterHash] = readVarint(bytes, afterCodec)
  const [length, start] = readVarint(bytes, afterHash)
  if (start + length !== bytes.length) throw new Error('CID length does not match its multihash')
  return { version, codec, hashCode, digest: bytes.slice(start) }
}

/** @param {string} text a CIDv1 in base32 ('b...') or base36 ('k...') */
export function parseCid (text) {
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(text)) throw new Error('CIDv0 (Qm...) is not supported')
  const prefix = text[0]
  const body = text.slice(1)
  if (prefix === 'b') return parseCidBytes(base32Decode(body))
  if (prefix === 'k') return parseCidBytes(base36Decode(body))
  throw new Error('unsupported multibase prefix')
}

/** @param {Cid} cid */
export function cidBytes (cid) {
  return Uint8Array.from([1, ...writeVarint(cid.codec), ...writeVarint(cid.hashCode), ...writeVarint(cid.digest.length), ...cid.digest])
}

/**
 * @param {Cid} cid
 * @param {'b' | 'k'} [base]
 */
export function cidToString (cid, base = 'b') {
  const bytes = cidBytes(cid)
  return base === 'k' ? 'k' + base36Encode(bytes) : 'b' + base32Encode(bytes)
}

/** The first and last characters of a long address, for a table cell. @param {string} text */
export function shorten (text, head = 10, tail = 6) {
  return text.length <= head + tail + 1 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`
}
