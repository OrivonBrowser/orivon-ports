// The slice of the protobuf wire format that dag-pb, UnixFS and IPNS records use: varints
// and length-delimited fields. Fixed-width fields are skipped.

import { readVarint } from './cid.js'

/**
 * @typedef {{ field: number, wire: number, value: number | Uint8Array }} Field
 */

/**
 * Every field of one message, in order.
 * @param {Uint8Array} bytes
 * @returns {Field[]}
 */
export function readFields (bytes) {
  /** @type {Field[]} */
  const fields = []
  let pos = 0
  while (pos < bytes.length) {
    const [tag, afterTag] = readVarint(bytes, pos)
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    pos = afterTag
    if (wire === 0) {
      const [value, next] = readVarint(bytes, pos)
      fields.push({ field, wire, value })
      pos = next
    } else if (wire === 2) {
      const [length, start] = readVarint(bytes, pos)
      if (start + length > bytes.length) throw new Error('truncated protobuf field')
      fields.push({ field, wire, value: bytes.slice(start, start + length) })
      pos = start + length
    } else if (wire === 1) {
      pos += 8
    } else if (wire === 5) {
      pos += 4
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
  }
  return fields
}

/**
 * A repeated varint field, whether written packed or one by one.
 * @param {Field[]} fields
 * @param {number} number
 * @returns {number[]}
 */
export function repeatedVarints (fields, number) {
  /** @type {number[]} */
  const out = []
  for (const { field, wire, value } of fields) {
    if (field !== number) continue
    if (wire === 0) out.push(/** @type {number} */ (value))
    else if (value instanceof Uint8Array) {
      let pos = 0
      while (pos < value.length) {
        const [item, next] = readVarint(value, pos)
        out.push(item)
        pos = next
      }
    }
  }
  return out
}
