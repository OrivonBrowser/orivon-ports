// A CBOR reader for the one thing it is used for: the signed Data map of an IPNS record.
// Definite lengths only; unsigned and negative integers, byte and text strings, arrays,
// maps, booleans and null.

import { text } from './bytes.js'

/**
 * @param {Uint8Array} bytes
 * @returns {unknown}
 */
export function decodeCbor (bytes) {
  const [value, end] = read(bytes, 0)
  if (end !== bytes.length) throw new Error('trailing bytes after CBOR value')
  return value
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {[unknown, number]}
 */
function read (bytes, offset) {
  const head = bytes[offset]
  if (head === undefined) throw new Error('truncated CBOR')
  const major = head >> 5
  const info = head & 31
  let pos = offset + 1
  if (major === 7) {
    if (info === 20) return [false, pos]
    if (info === 21) return [true, pos]
    if (info === 22) return [null, pos]
    throw new Error('unsupported CBOR simple value')
  }
  let argument = info
  if (info >= 24) {
    if (info > 27) throw new Error('unsupported CBOR length')
    const size = 2 ** (info - 24)
    argument = 0
    for (let i = 0; i < size; i++) argument = argument * 256 + (bytes[pos + i] ?? 0)
    pos += size
  }
  if (major === 0) return [argument, pos]
  if (major === 1) return [-1 - argument, pos]
  if (major === 2 || major === 3) {
    if (pos + argument > bytes.length) throw new Error('truncated CBOR string')
    const body = bytes.slice(pos, pos + argument)
    return [major === 2 ? body : text(body), pos + argument]
  }
  if (major === 4) {
    const items = []
    for (let i = 0; i < argument; i++) {
      const [item, next] = read(bytes, pos)
      items.push(item)
      pos = next
    }
    return [items, pos]
  }
  if (major === 5) {
    /** @type {Record<string, unknown>} */
    const map = {}
    for (let i = 0; i < argument; i++) {
      const [key, afterKey] = read(bytes, pos)
      const [item, next] = read(bytes, afterKey)
      map[String(key)] = item
      pos = next
    }
    return [map, pos]
  }
  throw new Error('unsupported CBOR type')
}
