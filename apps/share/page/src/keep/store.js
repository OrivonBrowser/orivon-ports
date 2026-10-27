// The shares kept on this computer. A share is written once, as the importer makes its blocks, and read by block
// afterwards: to serve it to a peer, to give it to a service, to export it as a CAR file. A block is found by CID in
// the share's own index only, so a share can never be asked for a block that belongs to another.

import { carHeader, carSectionHead } from '../ipfs/car.js'
import { parseCid } from '../ipfs/cid.js'

/**
 * What is known about a kept share besides its bytes.
 * @typedef {object} KeptMeta
 * @property {string} cid
 * @property {'files' | 'folder' | 'website'} kind
 * @property {boolean} encrypted
 * @property {number} bytes the size of what was shared
 * @property {number} files
 * @property {number} created
 * @property {boolean} online whether it is served while Share is open
 * @property {number} blocks
 * @property {number} stored bytes the pack takes
 */

/** @typedef {Map<string, [number, number]>} BlockIndex */

/** @param {import('./backends.js').Backend} backend */
export function createKeep (backend) {
  /** @type {Map<string, BlockIndex>} */
  const indexes = new Map()
  /** @type {Map<string, import('./backends.js').Pack>} */
  const packs = new Map()

  /** @param {string} root @returns {Promise<BlockIndex | null>} */
  async function indexOf (root) {
    const loaded = indexes.get(root)
    if (loaded !== undefined) return loaded
    const saved = await backend.get(root, 'index')
    if (saved === null || typeof saved !== 'object') return null
    const index = /** @type {BlockIndex} */ (new Map(Object.entries(saved)))
    indexes.set(root, index)
    return index
  }

  /** @param {string} root */
  async function packOf (root) {
    const loaded = packs.get(root)
    if (loaded !== undefined) return loaded
    const opened = await backend.open(root)
    if (opened !== null) packs.set(root, opened)
    return opened
  }

  /** @param {string} cid */
  const keyOf = (cid) => parseCid(cid).string

  const keep = {
    backend: backend.kind,
    durable: backend.durable,

    /**
     * Keeps a share: `writeBlocks` is handed a sink and gives it every block, in any order. A share with the same
     * address replaces the one kept before.
     * @param {string} cid
     * @param {Omit<KeptMeta, 'cid' | 'blocks' | 'stored' | 'created'> & { created?: number }} meta
     * @param {(sink: (cid: string, bytes: Uint8Array) => Promise<void>) => Promise<unknown>} writeBlocks
     * @returns {Promise<KeptMeta>}
     */
    async add (cid, meta, writeBlocks) {
      const root = keyOf(cid)
      await keep.remove(root)
      const writer = await backend.create(root)
      /** @type {BlockIndex} */
      const index = new Map()
      let offset = 0
      try {
        await writeBlocks(async (blockCid, bytes) => {
          if (index.has(blockCid)) return
          await writer.append(bytes)
          index.set(blockCid, [offset, bytes.length])
          offset += bytes.length
        })
        if (!index.has(root)) throw new Error('The share was not complete: its root block was never made.')
        await writer.close()
      } catch (error) {
        await writer.abort()
        throw error
      }
      /** @type {KeptMeta} */
      const kept = { ...meta, cid: root, created: meta.created ?? Date.now(), blocks: index.size, stored: offset }
      await backend.put(root, 'index', Object.fromEntries(index))
      await backend.put(root, 'meta', kept)
      indexes.set(root, index)
      return kept
    },

    /** @param {string} cid @returns {Promise<KeptMeta | null>} */
    async meta (cid) {
      const saved = await backend.get(keyOf(cid), 'meta')
      return saved !== null && typeof saved === 'object' && saved.cid === keyOf(cid) ? saved : null
    },

    /** @returns {Promise<KeptMeta[]>} newest first */
    async list () {
      const metas = await Promise.all((await backend.list()).map((root) => keep.meta(root)))
      return /** @type {KeptMeta[]} */ (metas.filter((meta) => meta !== null)).sort((a, b) => b.created - a.created)
    },

    /** @param {string} cid @param {boolean} online */
    async setOnline (cid, online) {
      const meta = await keep.meta(cid)
      if (meta === null) throw new Error('That share is not kept on this computer.')
      await backend.put(keyOf(cid), 'meta', { ...meta, online })
    },

    /** Whether `blockCid` belongs to the share `cid`. @param {string} cid @param {string} blockCid */
    async has (cid, blockCid) {
      const index = await indexOf(keyOf(cid))
      return index !== null && index.has(keyOf(blockCid))
    },

    /** @param {string} cid @param {string} blockCid @returns {Promise<Uint8Array | null>} */
    async block (cid, blockCid) {
      const root = keyOf(cid)
      const entry = (await indexOf(root))?.get(keyOf(blockCid))
      const pack = entry === undefined ? null : await packOf(root)
      return entry === undefined || pack === null ? null : await pack.read(entry[0], entry[1])
    },

    /** A block as a Blob that refers to where it is kept. @param {string} cid @param {string} blockCid @returns {Promise<Blob | null>} */
    async blob (cid, blockCid) {
      const root = keyOf(cid)
      const entry = (await indexOf(root))?.get(keyOf(blockCid))
      const pack = entry === undefined ? null : await packOf(root)
      return entry === undefined || pack === null ? null : pack.slice(entry[0], entry[1])
    },

    /** The share as a CAR file: a header, then every block as it lies in the pack, none of it read into memory. @param {string} cid @returns {Promise<Blob>} */
    async car (cid) {
      const root = keyOf(cid)
      const index = await indexOf(root)
      const pack = await packOf(root)
      if (index === null || pack === null) throw new Error('That share is not kept on this computer.')
      /** @type {BlobPart[]} */
      const parts = [/** @type {BlobPart} */ (carHeader(root))]
      for (const [blockCid, [offset, length]] of [...index].sort((a, b) => a[1][0] - b[1][0])) {
        parts.push(/** @type {BlobPart} */ (carSectionHead(blockCid, length)), pack.slice(offset, length))
      }
      return new Blob(parts, { type: 'application/vnd.ipld.car' })
    },

    /** The blocks of a share as CAR batches of at most `batchBytes`, each with a header naming its first block. @param {string} cid @param {number} batchBytes @param {(batch: Blob) => Promise<void>} onBatch */
    async eachBatch (cid, batchBytes, onBatch) {
      const root = keyOf(cid)
      const index = await indexOf(root)
      const pack = await packOf(root)
      if (index === null || pack === null) throw new Error('That share is not kept on this computer.')
      /** @type {BlobPart[]} */
      let parts = []
      let size = 0
      /** @type {string | null} */
      let first = null
      const flush = async () => {
        if (first === null) return
        const header = carHeader(first)
        await onBatch(new Blob([/** @type {BlobPart} */ (header), ...parts]))
        parts = []
        size = 0
        first = null
      }
      for (const [blockCid, [offset, length]] of [...index].sort((a, b) => a[1][0] - b[1][0])) {
        const head = carSectionHead(blockCid, length)
        if (first !== null && size + head.length + length + carHeader(first).length > batchBytes) await flush()
        first ??= blockCid
        parts.push(/** @type {BlobPart} */ (head), pack.slice(offset, length))
        size += head.length + length
      }
      await flush()
    },

    /** @param {string} cid */
    async remove (cid) {
      const root = keyOf(cid)
      indexes.delete(root)
      packs.delete(root)
      await backend.remove(root)
    },

    /** Bytes the kept shares take. */
    async usage () {
      return (await keep.list()).reduce((sum, meta) => sum + meta.stored, 0)
    }
  }
  return keep
}
