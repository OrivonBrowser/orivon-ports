// dag-pb nodes and the UnixFS record inside them: enough to list a folder and to walk a file.

import { readFields, repeatedVarints } from './protobuf.js'
import { text } from './bytes.js'

export const UNIXFS_TYPE = { 0: 'raw', 1: 'directory', 2: 'file', 3: 'metadata', 4: 'symlink', 5: 'sharded folder' }

/**
 * PBNode: Links (field 2, repeated: Hash 1, Name 2, Tsize 3) and Data (field 1).
 * @param {Uint8Array} bytes
 * @returns {{ links: { hash: Uint8Array, name: string, tsize: number }[], data: Uint8Array | null }}
 */
export function decodeDagPb (bytes) {
  /** @type {{ hash: Uint8Array, name: string, tsize: number }[]} */
  const links = []
  /** @type {Uint8Array | null} */
  let data = null
  for (const { field, value } of readFields(bytes)) {
    if (field === 1 && value instanceof Uint8Array) data = value
    if (field === 2 && value instanceof Uint8Array) {
      let hash = new Uint8Array(0)
      let name = ''
      let tsize = 0
      for (const part of readFields(value)) {
        if (part.field === 1 && part.value instanceof Uint8Array) hash = part.value
        if (part.field === 2 && part.value instanceof Uint8Array) name = text(part.value)
        if (part.field === 3 && typeof part.value === 'number') tsize = part.value
      }
      links.push({ hash, name, tsize })
    }
  }
  return { links, data }
}

/**
 * UnixFS Data: Type 1, Data 2, filesize 3, blocksizes 4 (repeated), hashType 5, fanout 6.
 * @param {Uint8Array} bytes
 * @returns {{ type: number, typeName: string, data: Uint8Array | null, filesize: number | null, blocksizes: number[], fanout: number | null }}
 */
export function decodeUnixfs (bytes) {
  const fields = readFields(bytes)
  let type = 0
  /** @type {Uint8Array | null} */
  let data = null
  /** @type {number | null} */
  let filesize = null
  /** @type {number | null} */
  let fanout = null
  for (const { field, value } of fields) {
    if (field === 1 && typeof value === 'number') type = value
    if (field === 2 && value instanceof Uint8Array) data = value
    if (field === 3 && typeof value === 'number') filesize = value
    if (field === 6 && typeof value === 'number') fanout = value
  }
  return { type, typeName: /** @type {Record<number, string>} */ (UNIXFS_TYPE)[type] ?? `type ${type}`, data, filesize, blocksizes: repeatedVarints(fields, 4), fanout }
}
