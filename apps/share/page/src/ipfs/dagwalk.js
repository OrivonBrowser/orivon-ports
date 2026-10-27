// Walks a UnixFS DAG through a function that gets one block by CID: the kept share on this computer, a peer, a
// gateway. The source is responsible for the block being the one asked for; the walk only follows links, so what it
// reads is exactly what the root names.

import { DAG_PB, RAW, parseCid, readCidBytes } from './cid.js'
import { decodeNode, decodeUnixfs, UNIXFS_FILE } from './dagpb.js'
import { describeBlock } from './dagread.js'

const SEGMENT_BYTES = 32 * 1024 * 1024

/**
 * @typedef {object} BlockSource
 * @property {(cid: string) => Promise<Uint8Array>} block the block with this CID, or a rejection
 * @property {(cid: string) => Promise<Blob | null>} [blob] a raw leaf as a Blob that refers to where it is kept, when that costs nothing
 */

/** Runs `fn` over `items` with at most `limit` at once; results keep the order of `items`. @template T,R @param {T[]} items @param {number} limit @param {(item: T, index: number) => Promise<R>} fn @param {AbortSignal} [signal] @returns {Promise<R[]>} */
export async function mapLimit (items, limit, fn, signal) {
  /** @type {R[]} */
  const results = new Array(items.length)
  let next = 0
  let failure = null
  const worker = async () => {
    while (failure === null) {
      signal?.throwIfAborted()
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await fn(/** @type {T} */ (items[index]), index)
      } catch (error) {
        failure ??= { error }
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failure !== null) throw /** @type {{ error: unknown }} */ (failure).error
  return results
}

/** @param {string} name */
function safeName (name) {
  if (name === '' || name === '.' || name === '..' || /[/\\\u0000]/.test(name)) throw new Error('This share holds a name that cannot be opened safely.')
  return name
}

/**
 * Every file below a directory, with its path and size. A file of several blocks is sized by its own node; a file of
 * one block (the common small file) by the size its directory link states, which saves a request for each, and is
 * only what is shown: reading the file gives its real bytes.
 * @param {BlockSource} source @param {string} rootCid
 * @param {{ signal?: AbortSignal, concurrency?: number, maxFiles?: number }} [options]
 * @returns {Promise<{ path: string, cid: string, size: number }[]>}
 */
export async function listTree (source, rootCid, { signal, concurrency = 8, maxFiles = 10000 } = {}) {
  /** @type {{ path: string, cid: string, size: number }[]} */
  const files = []
  /** @type {{ path: string, cid: string }[]} */
  let level = [{ path: '', cid: parseCid(rootCid).string }]
  let first = true
  while (level.length > 0) {
    const described = await mapLimit(level, concurrency, async (item) => ({ item, info: describeBlock(item.cid, await source.block(item.cid)) }), signal)
    /** @type {{ path: string, cid: string }[]} */
    const next = []
    for (const { item, info } of described) {
      if (info.type === 'hamt') throw new Error('This share has a folder Share cannot read (it is stored in many parts).')
      if (info.type === 'directory') {
        for (const entry of info.entries) {
          const path = item.path === '' ? safeName(entry.name) : `${item.path}/${safeName(entry.name)}`
          if (parseCid(entry.cid).codec === RAW) files.push({ path, cid: entry.cid, size: entry.tsize })
          else next.push({ path, cid: entry.cid })
        }
        if (files.length > maxFiles) throw new Error(`This share holds more than ${maxFiles} files, more than Share opens.`)
      } else if (info.type === 'raw' || info.type === 'file') {
        if (first) throw new Error('This address is a file, not a share.')
        files.push({ path: item.path, cid: item.cid, size: info.size })
        if (files.length > maxFiles) throw new Error(`This share holds more than ${maxFiles} files, more than Share opens.`)
      } else {
        throw new Error('This share holds something Share cannot read.')
      }
    }
    first = false
    level = next
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** @param {Uint8Array} hash */
function linkCid (hash) {
  return readCidBytes(hash).cid.string
}

/**
 * The leaves of a file in order: the node's own links, followed level by level.
 * @param {BlockSource} source @param {string} rootCid @param {AbortSignal | undefined} signal @param {number} concurrency
 * @returns {Promise<{ leaves: string[], inline: Uint8Array | null, size: number | undefined, raw: Uint8Array | null }>}
 */
async function leavesOf (source, rootCid, signal, concurrency) {
  const top = await source.block(rootCid)
  if (parseCid(rootCid).codec === RAW) return { leaves: [], inline: null, size: top.length, raw: top }
  if (parseCid(rootCid).codec !== DAG_PB) throw new Error('This share holds something Share cannot read.')
  const node = decodeNode(top)
  const unixfs = node.data === undefined ? undefined : decodeUnixfs(node.data)
  if (!unixfs || unixfs.type !== UNIXFS_FILE && unixfs.type !== 0) throw new Error('This address is not a file.')
  /** @type {string[]} */
  let level = node.links.map((link) => linkCid(link.hash))
  const leaves = /** @type {string[]} */ ([])
  while (level.length > 0) {
    const inner = level.filter((cid) => parseCid(cid).codec === DAG_PB)
    if (inner.length === 0) {
      leaves.push(...level)
      break
    }
    // A level holds either leaves or nodes in Kubo's layout; a mixed level is read in order all the same.
    const children = await mapLimit(level, concurrency, async (cid) => parseCid(cid).codec === DAG_PB ? decodeNode(await source.block(cid)).links.map((link) => linkCid(link.hash)) : [cid], signal)
    level = children.flat()
  }
  return { leaves, inline: unixfs.data ?? null, size: unixfs.filesize, raw: null }
}

/**
 * A whole file as a Blob. Leaves are asked for `concurrency` at a time, and gathered into Blobs of about 32 MiB so
 * that a large file is not held as thousands of arrays.
 * @param {BlockSource} source @param {string} cid
 * @param {{ signal?: AbortSignal, concurrency?: number, onBytes?: (bytes: number) => void }} [options]
 * @returns {Promise<Blob>}
 */
export async function readFileBlob (source, cid, { signal, concurrency = 16, onBytes } = {}) {
  const { leaves, inline, size, raw } = await leavesOf(source, parseCid(cid).string, signal, concurrency)
  if (raw !== null) {
    onBytes?.(raw.length)
    return new Blob([/** @type {BlobPart} */ (raw)])
  }
  /** @type {Blob[]} */
  const segments = []
  /** @type {BlobPart[]} */
  let parts = inline === null ? [] : [/** @type {BlobPart} */ (inline)]
  let held = inline?.length ?? 0
  let total = held
  const batch = concurrency * 4
  for (let at = 0; at < leaves.length; at += batch) {
    signal?.throwIfAborted()
    const got = await mapLimit(leaves.slice(at, at + batch), concurrency, async (leaf) => {
      const asBlob = source.blob === undefined ? null : await source.blob(leaf)
      if (asBlob !== null) return asBlob
      return await source.block(leaf)
    }, signal)
    for (const piece of got) {
      const length = piece instanceof Blob ? piece.size : piece.length
      parts.push(/** @type {BlobPart} */ (piece))
      held += length
      total += length
      onBytes?.(length)
    }
    if (held >= SEGMENT_BYTES) {
      segments.push(new Blob(parts))
      parts = []
      held = 0
    }
  }
  if (parts.length > 0) segments.push(new Blob(parts))
  if (size !== undefined && size !== total) throw new Error(`A file is ${total} bytes but its node says ${size}.`)
  return new Blob(segments)
}
