// A UnixFS importer that produces the same CIDs as Kubo's
// `ipfs add -r --cid-version=1`: 256 KiB fixed chunks, raw leaves, a balanced
// tree of at most 174 links per node, and flat directories (no sharding).
// Everything is computed locally; the returned blocks are what a CAR carries.

import { cidFor, DAG_PB, RAW } from './cid.js'
import { encodeNode, encodeUnixfs, UNIXFS_DIRECTORY, UNIXFS_FILE } from './dagpb.js'

export const CHUNK_SIZE = 262144
export const MAX_LINKS = 174
export const MAX_DIRECTORY_ENTRIES = 1000

const encoder = new TextEncoder()

/**
 * @typedef {object} Imported
 * @property {string} cid the root, CIDv1 base32
 * @property {Map<string, Uint8Array>} blocks every block, by CIDv1 base32 string
 * @property {number} size the cumulative DAG size of the root (its Tsize)
 */

/**
 * One built node as its parent links it: `fileSize` is the file bytes below
 * it, `tsize` the encoded DAG size below and including it.
 * @typedef {{ cid: import('./cid.js').Cid, fileSize: number, tsize: number }} Built
 */

/** @param {Map<string, Uint8Array>} blocks @param {number} codec @param {Uint8Array} bytes */
async function putBlock (blocks, codec, bytes) {
  const cid = await cidFor(codec, bytes)
  blocks.set(cid.string, bytes)
  return cid
}

/**
 * @param {Uint8Array} bytes
 * @param {Map<string, Uint8Array>} blocks
 * @returns {Promise<Built>}
 */
async function buildFile (bytes, blocks) {
  /** @type {Built[]} */
  let level = []
  const chunks = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE))
  for (let i = 0; i < chunks; i++) {
    const chunk = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
    level.push({ cid: await putBlock(blocks, RAW, chunk), fileSize: chunk.length, tsize: chunk.length })
  }
  while (level.length > 1) {
    /** @type {Built[]} */
    const next = []
    for (let at = 0; at < level.length; at += MAX_LINKS) {
      next.push(await buildFileNode(level.slice(at, at + MAX_LINKS), blocks))
    }
    level = next
  }
  return /** @type {Built} */ (level[0])
}

/** @param {Built[]} children @param {Map<string, Uint8Array>} blocks @returns {Promise<Built>} */
async function buildFileNode (children, blocks) {
  const fileSize = children.reduce((sum, child) => sum + child.fileSize, 0)
  const data = encodeUnixfs({
    type: UNIXFS_FILE, filesize: fileSize, blocksizes: children.map((child) => child.fileSize)
  })
  const links = children.map((child) => ({ hash: child.cid.bytes, name: '', tsize: child.tsize }))
  const node = encodeNode(links, data)
  const cid = await putBlock(blocks, DAG_PB, node)
  return { cid, fileSize, tsize: node.length + children.reduce((sum, child) => sum + child.tsize, 0) }
}

/** A single file's blocks and root CID. @param {Uint8Array} bytes @returns {Promise<Imported>} */
export async function importFile (bytes) {
  const blocks = new Map()
  const built = await buildFile(bytes, blocks)
  return { cid: built.cid.string, blocks, size: built.tsize }
}

/**
 * @typedef {{ files: Map<string, Uint8Array>, dirs: Map<string, DirTree> }} DirTree
 */

/** @returns {DirTree} */
function emptyTree () {
  return { files: new Map(), dirs: new Map() }
}

/** @param {string} path @returns {string[]} */
function splitPath (path) {
  if (typeof path !== 'string' || path === '') throw new Error('a file path must not be empty')
  if (path.startsWith('/')) throw new Error(`an absolute path is not allowed: ${path}`)
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '') throw new Error(`an empty path segment is not allowed: ${path}`)
    if (segment === '.' || segment === '..') throw new Error(`"${segment}" is not allowed in a path: ${path}`)
    if (segment.isWellFormed && !segment.isWellFormed()) throw new Error(`a path is not valid Unicode: ${path}`)
  }
  return segments
}

/** @param {{ path: string, bytes: Uint8Array }[]} files @returns {DirTree} */
function buildTree (files) {
  const root = emptyTree()
  const seen = new Set()
  for (const file of files) {
    const segments = splitPath(file.path)
    if (seen.has(file.path)) throw new Error(`duplicate path: ${file.path}`)
    seen.add(file.path)
    let dir = root
    for (const segment of segments.slice(0, -1)) {
      if (dir.files.has(segment)) throw new Error(`"${segment}" is both a file and a directory in ${file.path}`)
      let child = dir.dirs.get(segment)
      if (!child) dir.dirs.set(segment, (child = emptyTree()))
      dir = child
    }
    const name = /** @type {string} */ (segments[segments.length - 1])
    if (dir.dirs.has(name)) throw new Error(`"${name}" is both a file and a directory in ${file.path}`)
    dir.files.set(name, file.bytes)
  }
  return root
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function compareBytes (a, b) {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return /** @type {number} */ (a[i]) - /** @type {number} */ (b[i])
  }
  return a.length - b.length
}

/** @param {DirTree} tree @param {Map<string, Uint8Array>} blocks @returns {Promise<Built>} */
async function buildDirectory (tree, blocks) {
  if (tree.files.size + tree.dirs.size > MAX_DIRECTORY_ENTRIES) {
    throw new Error(`a directory with more than ${MAX_DIRECTORY_ENTRIES} entries needs sharding, which is not supported`)
  }
  /** @type {{ name: string, key: Uint8Array, built: Built }[]} */
  const entries = []
  for (const [name, bytes] of tree.files) {
    entries.push({ name, key: encoder.encode(name), built: await buildFile(bytes, blocks) })
  }
  for (const [name, child] of tree.dirs) {
    entries.push({ name, key: encoder.encode(name), built: await buildDirectory(child, blocks) })
  }
  entries.sort((a, b) => compareBytes(a.key, b.key))
  const links = entries.map((entry) => ({ hash: entry.built.cid.bytes, name: entry.name, tsize: entry.built.tsize }))
  const node = encodeNode(links, encodeUnixfs({ type: UNIXFS_DIRECTORY, blocksizes: [] }))
  const cid = await putBlock(blocks, DAG_PB, node)
  return { cid, fileSize: 0, tsize: node.length + entries.reduce((sum, entry) => sum + entry.built.tsize, 0) }
}

/**
 * A directory of files, `/`-separated relative paths, nested directories made
 * from the paths.
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @returns {Promise<Imported>}
 */
export async function importDirectory (files) {
  const tree = buildTree(files)
  const blocks = new Map()
  const built = await buildDirectory(tree, blocks)
  return { cid: built.cid.string, blocks, size: built.tsize }
}
