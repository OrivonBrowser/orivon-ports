// The byte formats the IPNS module reads and writes: base64 and base36 text, the protobuf
// fields of records and keys, and DAG-CBOR. Plain JavaScript with no dependencies.

import { concatBytes } from './cid.js'

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

/** Standard or URL-safe base64, with or without padding. @param {string} text @returns {Uint8Array} */
export function fromBase64 (text) {
  const clean = text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '=')), (char) => char.charCodeAt(0))
}

/** @param {Uint8Array} bytes */
export function base36Encode (bytes) {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let number = 0n
  for (const byte of bytes) number = (number << 8n) | BigInt(byte)
  return '0'.repeat(zeros) + (number === 0n ? '' : number.toString(36))
}

/** @param {string} text @returns {Uint8Array} */
export function base36Decode (text) {
  if (!/^[0-9a-z]*$/.test(text)) throw new Error('invalid base36 character')
  let zeros = 0
  while (zeros < text.length && text[zeros] === '0') zeros++
  let number = 0n
  for (const char of text) number = number * 36n + BigInt(parseInt(char, 36))
  let hex = number === 0n ? '' : number.toString(16)
  if (hex.length % 2 === 1) hex = '0' + hex
  const out = new Uint8Array(zeros + hex.length / 2)
  for (let i = 0; i < hex.length / 2; i++) out[zeros + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

// Protobuf: just the two wire types the records and keys use

/** @param {bigint | number} value */
function varint (value) {
  let rest = BigInt(value)
  const out = []
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80)
    rest >>= 7n
  }
  out.push(Number(rest))
  return Uint8Array.from(out)
}

/** @param {number} field @param {bigint | number} value */
export const fieldVarint = (field, value) => concatBytes([varint(field << 3), varint(value)])
/** @param {number} field @param {Uint8Array} bytes */
export const fieldBytes = (field, bytes) => concatBytes([varint((field << 3) | 2), varint(bytes.length), bytes])

/** @param {Uint8Array} bytes @param {number} at @returns {{ value: bigint, next: number }} */
function readVarint (bytes, at) {
  let value = 0n
  for (let i = 0; i < 10; i++) {
    const byte = bytes[at + i]
    if (byte === undefined) break
    value |= BigInt(byte & 0x7f) << BigInt(7 * i)
    if ((byte & 0x80) === 0) {
      if (value >= 1n << 64n) break
      return { value, next: at + i + 1 }
    }
  }
  throw new Error('bad varint')
}

/**
 * The fields named in `known` (their type checked, each at most once); every other field is
 * skipped. Throws a plain Error for anything that is not protobuf.
 * @param {Uint8Array} bytes
 * @param {Record<number, 'varint' | 'bytes'>} known
 * @returns {Map<number, bigint | Uint8Array>}
 */
export function readFields (bytes, known) {
  /** @type {Map<number, bigint | Uint8Array>} */
  const out = new Map()
  let at = 0
  while (at < bytes.length) {
    const tag = readVarint(bytes, at)
    const field = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    at = tag.next
    /** @type {bigint | Uint8Array | undefined} */
    let value
    if (field === 0) throw new Error('field 0')
    if (wire === 0) {
      const read = readVarint(bytes, at)
      value = read.value
      at = read.next
    } else if (wire === 2) {
      const length = readVarint(bytes, at)
      if (length.value > BigInt(bytes.length - length.next)) throw new Error('truncated field')
      value = bytes.subarray(length.next, length.next + Number(length.value))
      at = length.next + Number(length.value)
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
      if (at > bytes.length) throw new Error('truncated field')
    } else {
      throw new Error('unknown wire type')
    }
    const type = known[field]
    if (type === undefined) continue
    if (value === undefined || (type === 'varint') !== (wire === 0)) throw new Error('wrong field type')
    if (out.has(field)) throw new Error('repeated field')
    out.set(field, value)
  }
  return out
}

// DAG-CBOR: the writer for the record's data, and a strict reader

/** The shortest head: the major type, then the argument. @param {number} major @param {bigint | number} value */
function cborHead (major, value) {
  const n = BigInt(value)
  if (n < 24n) return Uint8Array.of((major << 5) | Number(n))
  const size = n < 0x100n ? 1 : n < 0x10000n ? 2 : n < 0x100000000n ? 4 : 8
  const out = new Uint8Array(1 + size)
  out[0] = (major << 5) | (24 + Math.log2(size))
  for (let i = 0; i < size; i++) out[size - i] = Number((n >> BigInt(8 * i)) & 0xffn)
  return out
}

/** @param {string} text */
const cborText = (text) => concatBytes([cborHead(3, text.length), encoder.encode(text)])
/** @param {Uint8Array} bytes */
const cborBytes = (bytes) => concatBytes([cborHead(2, bytes.length), bytes])
/** @param {bigint | number} value */
const cborUint = (value) => cborHead(0, value)

/**
 * The record's data map. DAG-CBOR sorts keys by length, then bytewise: that is this order.
 * @param {{ valueBytes: Uint8Array, validityBytes: Uint8Array, sequence: number, ttlNs: bigint }} record
 */
export function encodeData (record) {
  return concatBytes([
    cborHead(5, 5),
    cborText('TTL'), cborUint(record.ttlNs),
    cborText('Value'), cborBytes(record.valueBytes),
    cborText('Sequence'), cborUint(record.sequence),
    cborText('Validity'), cborBytes(record.validityBytes),
    cborText('ValidityType'), cborUint(0)
  ])
}

const MIN_FOR_SIZE = { 1: 24n, 2: 0x100n, 4: 0x10000n, 8: 0x100000000n }

/**
 * One data item. Integers must be in their shortest form and map keys sorted, as DAG-CBOR
 * requires, so there is one encoding for one meaning. Tags and indefinite lengths are refused.
 * @param {Uint8Array} bytes @param {number} at @param {number} depth
 * @returns {{ value: any, next: number }}
 */
export function readCbor (bytes, at, depth) {
  const initial = bytes[at]
  if (initial === undefined || depth > 8) throw new Error('bad CBOR')
  const major = initial >> 5
  const info = initial & 31
  if (major === 7) {
    if (info === 20 || info === 21) return { value: info === 21, next: at + 1 }
    if (info === 22) return { value: null, next: at + 1 }
    if (info === 27 && at + 9 <= bytes.length) return { value: new DataView(bytes.buffer, bytes.byteOffset + at + 1, 8).getFloat64(0), next: at + 9 }
    throw new Error('bad CBOR simple value')
  }
  let argument = BigInt(info)
  let next = at + 1
  if (info >= 24) {
    if (info > 27) throw new Error('bad CBOR length')
    const size = 1 << (info - 24)
    if (next + size > bytes.length) throw new Error('truncated CBOR')
    argument = 0n
    for (let i = 0; i < size; i++) argument = (argument << 8n) | BigInt(/** @type {number} */ (bytes[next + i]))
    if (argument < MIN_FOR_SIZE[/** @type {1 | 2 | 4 | 8} */ (size)]) throw new Error('CBOR integer not in shortest form')
    next += size
  }
  if (major === 0) return { value: argument, next }
  if (major === 1) return { value: -1n - argument, next }
  if (major === 6) throw new Error('CBOR tags are not allowed')
  if (argument > BigInt(bytes.length - next)) throw new Error('truncated CBOR')
  const count = Number(argument)
  if (major === 2) return { value: bytes.slice(next, next + count), next: next + count }
  if (major === 3) return { value: strictDecoder.decode(bytes.subarray(next, next + count)), next: next + count }
  if (major === 4) {
    const items = []
    for (let i = 0; i < count; i++) {
      const item = readCbor(bytes, next, depth + 1)
      items.push(item.value)
      next = item.next
    }
    return { value: items, next }
  }
  const map = new Map()
  /** @type {Uint8Array | null} */
  let previous = null
  for (let i = 0; i < count; i++) {
    const key = readCbor(bytes, next, depth + 1)
    if (typeof key.value !== 'string') throw new Error('CBOR map key is not text')
    const raw = encoder.encode(key.value)
    if (previous !== null && !keyOrder(previous, raw)) throw new Error('CBOR map keys out of order')
    previous = raw
    const item = readCbor(bytes, key.next, depth + 1)
    map.set(key.value, item.value)
    next = item.next
  }
  return { value: map, next }
}

/** True when key `a` sorts before `b`: shorter first, then bytewise. @param {Uint8Array} a @param {Uint8Array} b */
function keyOrder (a, b) {
  if (a.length !== b.length) return a.length < b.length
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return /** @type {number} */ (a[i]) < /** @type {number} */ (b[i])
  return false
}
