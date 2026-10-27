// Reads UnixFS files and directories out of a map of verified blocks: walk a
// path by directory entry names, join a file's raw and dag-pb leaves.

import { DAG_PB, RAW, concatBytes, parseCid, readCidBytes } from './cid.js'
import { decodeNode, decodeUnixfs, UNIXFS_DIRECTORY, UNIXFS_FILE } from './dagpb.js'

const UNIXFS_RAW = 0
const UNIXFS_HAMT_SHARD = 5

/** @param {Map<string, Uint8Array>} blocks @param {string} cid @returns {Uint8Array} */
function getBlock (blocks, cid) {
  const block = blocks.get(parseCid(cid).string)
  if (!block) throw new Error(`missing block ${cid}`)
  return block
}

/** @param {Map<string, Uint8Array>} blocks @param {string} cid */
function getNode (blocks, cid) {
  const node = decodeNode(getBlock(blocks, cid))
  const unixfs = node.data === undefined ? undefined : decodeUnixfs(node.data)
  if (!unixfs) throw new Error(`dag-pb node ${cid} has no UnixFS data`)
  return { links: node.links, unixfs }
}

/** @param {Uint8Array} hash */
function linkCid (hash) {
  return readCidBytes(hash).cid.string
}

/**
 * The entries of a UnixFS directory, in stored order; `tsize` is what the link says the entry weighs, nodes included.
 * @param {Map<string, Uint8Array>} blocks @param {string} cid
 * @returns {{ name: string, cid: string, tsize: number }[]}
 */
export function listDirectory (blocks, cid) {
  if (parseCid(cid).codec !== DAG_PB) throw new Error(`${cid} is not a directory`)
  const { links, unixfs } = getNode(blocks, cid)
  if (unixfs.type === UNIXFS_HAMT_SHARD) throw new Error(`${cid} is a sharded directory, which is not supported`)
  if (unixfs.type !== UNIXFS_DIRECTORY) throw new Error(`${cid} is not a directory`)
  return links.map((link) => ({ name: link.name ?? '', cid: linkCid(link.hash), tsize: link.tsize ?? 0 }))
}

/**
 * What one block is, from its own bytes: a raw leaf, a file node with the size it declares, a directory with its
 * entries, or a sharded directory (not supported).
 * @typedef {{ type: 'raw' | 'file' | 'directory' | 'hamt' | 'other', size: number, entries: { name: string, cid: string, tsize: number }[] }} BlockInfo
 * @param {string} cid @param {Uint8Array} bytes
 * @returns {BlockInfo}
 */
export function describeBlock (cid, bytes) {
  const { codec } = parseCid(cid)
  if (codec === RAW) return { type: 'raw', size: bytes.length, entries: [] }
  if (codec !== DAG_PB) return { type: 'other', size: 0, entries: [] }
  const node = decodeNode(bytes)
  const unixfs = node.data === undefined ? undefined : decodeUnixfs(node.data)
  if (!unixfs) return { type: 'other', size: 0, entries: [] }
  if (unixfs.type === UNIXFS_HAMT_SHARD) return { type: 'hamt', size: 0, entries: [] }
  if (unixfs.type === UNIXFS_DIRECTORY) {
    return { type: 'directory', size: 0, entries: node.links.map((link) => ({ name: link.name ?? '', cid: linkCid(link.hash), tsize: link.tsize ?? 0 })) }
  }
  if (unixfs.type === UNIXFS_FILE || unixfs.type === UNIXFS_RAW) return { type: 'file', size: unixfs.filesize ?? unixfs.data?.length ?? 0, entries: [] }
  return { type: 'other', size: 0, entries: [] }
}

/** @param {Map<string, Uint8Array>} blocks @param {string} cid @param {Uint8Array[]} out */
function collectFile (blocks, cid, out) {
  const { codec } = parseCid(cid)
  if (codec === RAW) {
    out.push(getBlock(blocks, cid))
    return
  }
  if (codec !== DAG_PB) throw new Error(`${cid} has an unsupported codec 0x${codec.toString(16)}`)
  const { links, unixfs } = getNode(blocks, cid)
  if (unixfs.type !== UNIXFS_FILE && unixfs.type !== UNIXFS_RAW) throw new Error(`${cid} is not a file`)
  if (unixfs.data) out.push(unixfs.data)
  for (const link of links) collectFile(blocks, linkCid(link.hash), out)
}

/**
 * The bytes of the file at `path` below `rootCid` (an empty path is the root
 * itself).
 * @param {Map<string, Uint8Array>} blocks @param {string} rootCid @param {string} path
 * @returns {Uint8Array}
 */
export function readPath (blocks, rootCid, path) {
  let cid = parseCid(rootCid).string
  for (const name of path.split('/').filter((segment) => segment !== '')) {
    if (name === '.' || name === '..') throw new Error(`"${name}" is not allowed in a path`)
    const entry = listDirectory(blocks, cid).find((candidate) => candidate.name === name)
    if (!entry) throw new Error(`no entry named ${JSON.stringify(name)} in ${cid}`)
    cid = entry.cid
  }
  /** @type {Uint8Array[]} */
  const parts = []
  if (parseCid(cid).codec === DAG_PB && getNode(blocks, cid).unixfs.type === UNIXFS_DIRECTORY) {
    throw new Error(`${path || cid} is a directory, not a file`)
  }
  collectFile(blocks, cid, parts)
  const bytes = concatBytes(parts)
  if (parseCid(cid).codec === DAG_PB) {
    const { filesize } = getNode(blocks, cid).unixfs
    if (filesize !== undefined && filesize !== bytes.length) {
      throw new Error(`file ${cid} is ${bytes.length} bytes but its node says ${filesize}`)
    }
  }
  return bytes
}

/**
 * The file at `cid` as a Blob: its leaves joined in order, the size its node declares checked.
 * @param {Map<string, Uint8Array>} blocks @param {string} cid
 * @returns {Blob}
 */
export function readFileBlob (blocks, cid) {
  /** @type {Uint8Array[]} */
  const parts = []
  collectFile(blocks, cid, parts)
  let size = 0
  for (const part of parts) size += part.length
  if (parseCid(cid).codec === DAG_PB) {
    const { filesize } = getNode(blocks, cid).unixfs
    if (filesize !== undefined && filesize !== size) throw new Error(`file ${cid} is ${size} bytes but its node says ${filesize}`)
  }
  return new Blob(/** @type {BlobPart[]} */ (parts))
}
