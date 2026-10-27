// dag-pb nodes and the UnixFS message inside them, encoded and decoded by
// hand. Encoding is canonical: Links (field 2) come before Data (field 1).

import { concatBytes, decodeVarint, encodeVarint } from './cid.js'

export const UNIXFS_DIRECTORY = 1
export const UNIXFS_FILE = 2

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** @typedef {{ hash: Uint8Array, name?: string, tsize?: number }} PbLink */
/** @typedef {{ type: number, data?: Uint8Array, filesize?: number, blocksizes: number[] }} UnixfsData */

/** @param {number} field @param {Uint8Array} bytes */
function lengthDelimited (field, bytes) {
  return concatBytes([encodeVarint((field << 3) | 2), encodeVarint(bytes.length), bytes])
}

/** @param {number} field @param {number} value */
function varintField (field, value) {
  return concatBytes([encodeVarint(field << 3), encodeVarint(value)])
}

/**
 * A `PBNode`. A link without `name` omits the field; `name: ''` writes it empty.
 * @param {PbLink[]} links @param {Uint8Array} [data]
 */
export function encodeNode (links, data) {
  const parts = []
  for (const link of links) {
    const fields = [lengthDelimited(1, link.hash)]
    if (link.name !== undefined) fields.push(lengthDelimited(2, encoder.encode(link.name)))
    if (link.tsize !== undefined) fields.push(varintField(3, link.tsize))
    parts.push(lengthDelimited(2, concatBytes(fields)))
  }
  if (data !== undefined) parts.push(lengthDelimited(1, data))
  return concatBytes(parts)
}

/** The UnixFS `Data` message: Type, Data, filesize, then one blocksize per child. @param {UnixfsData} unixfs */
export function encodeUnixfs (unixfs) {
  const parts = [varintField(1, unixfs.type)]
  if (unixfs.data !== undefined) parts.push(lengthDelimited(2, unixfs.data))
  if (unixfs.filesize !== undefined) parts.push(varintField(3, unixfs.filesize))
  for (const size of unixfs.blocksizes) parts.push(varintField(4, size))
  return concatBytes(parts)
}

/**
 * Walks the fields of a protobuf message; `onField` gets the field number and
 * either a varint value or the length-delimited bytes.
 * @param {Uint8Array} bytes
 * @param {(field: number, value: number | Uint8Array) => void} onField
 */
function eachField (bytes, onField) {
  let at = 0
  while (at < bytes.length) {
    const key = decodeVarint(bytes, at)
    at += key.length
    const field = Math.floor(key.value / 8)
    const wire = key.value % 8
    if (wire === 0) {
      const value = decodeVarint(bytes, at)
      at += value.length
      onField(field, value.value)
    } else if (wire === 2) {
      const size = decodeVarint(bytes, at)
      at += size.length
      if (at + size.value > bytes.length) throw new Error('truncated protobuf field')
      onField(field, bytes.subarray(at, at + size.value))
      at += size.value
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`)
    }
  }
}

/** @param {Uint8Array} bytes @returns {{ links: PbLink[], data?: Uint8Array }} */
export function decodeNode (bytes) {
  /** @type {PbLink[]} */
  const links = []
  /** @type {Uint8Array | undefined} */
  let data
  eachField(bytes, (field, value) => {
    if (!(value instanceof Uint8Array)) throw new Error('malformed dag-pb node')
    if (field === 1) data = value
    else if (field === 2) links.push(decodeLink(value))
  })
  return data === undefined ? { links } : { links, data }
}

/** @param {Uint8Array} bytes @returns {PbLink} */
function decodeLink (bytes) {
  /** @type {Uint8Array | undefined} */
  let hash
  /** @type {string | undefined} */
  let name
  /** @type {number | undefined} */
  let tsize
  eachField(bytes, (field, value) => {
    if (field === 1 && value instanceof Uint8Array) hash = value
    else if (field === 2 && value instanceof Uint8Array) name = decoder.decode(value)
    else if (field === 3 && typeof value === 'number') tsize = value
  })
  if (hash === undefined) throw new Error('dag-pb link without a hash')
  /** @type {PbLink} */
  const link = { hash }
  if (name !== undefined) link.name = name
  if (tsize !== undefined) link.tsize = tsize
  return link
}

/** @param {Uint8Array} bytes @returns {UnixfsData} */
export function decodeUnixfs (bytes) {
  /** @type {UnixfsData} */
  const out = { type: -1, blocksizes: [] }
  eachField(bytes, (field, value) => {
    if (field === 1 && typeof value === 'number') out.type = value
    else if (field === 2 && value instanceof Uint8Array) out.data = value
    else if (field === 3 && typeof value === 'number') out.filesize = value
    else if (field === 4 && typeof value === 'number') out.blocksizes.push(value)
    else if (field === 4 && value instanceof Uint8Array) {
      for (let at = 0; at < value.length;) {
        const size = decodeVarint(value, at)
        out.blocksizes.push(size.value)
        at += size.length
      }
    }
  })
  if (out.type < 0) throw new Error('UnixFS data without a type')
  return out
}
