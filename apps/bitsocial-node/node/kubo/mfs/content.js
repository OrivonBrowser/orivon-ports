// A file's bytes into blocks and back. The blocks go to the node as they are made; the file's CID and sizes are what
// the tree keeps, and its bytes are read from the node again when a write has to change part of them.

import { importer } from 'ipfs-unixfs-importer'
import { fixedSize } from 'ipfs-unixfs-importer/chunker'
import { nodeBlockstore } from '../ipfs.js'

const CHUNK_BYTES = 262_144

/**
 * @typedef {object} ImportedFile
 * @property {import('multiformats/cid').CID} cid
 * @property {number} size the file's length
 * @property {bigint} tsize the cumulative size of its blocks
 * @property {number} blocks the links its root block holds
 */

/**
 * @param {Parameters<typeof nodeBlockstore>[0]} node @param {Uint8Array} bytes @param {{ version: 0 | 1, rawLeaves: boolean }} layout
 * @returns {Promise<ImportedFile>}
 */
export async function importFile (node, bytes, { version, rawLeaves }) {
  /** @type {import('ipfs-unixfs-importer').ImportResult | undefined} */
  let root
  for await (const entry of importer([{ content: bytes }], /** @type {any} */ (nodeBlockstore(node)), {
    cidVersion: version, rawLeaves, chunker: fixedSize({ chunkSize: CHUNK_BYTES })
  })) root = entry
  if (root === undefined) throw new Error('the importer made no file')
  return { cid: root.cid, size: bytes.length, tsize: root.size, blocks: root.unixfs?.blockSizes.length ?? 0 }
}
