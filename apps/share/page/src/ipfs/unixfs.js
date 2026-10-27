// A UnixFS importer that produces the same CIDs as Kubo's `ipfs add -r --cid-version=1`: 256 KiB fixed chunks,
// raw leaves, a balanced tree of at most 174 links per node, and flat directories (no sharding). A file is read
// from a Blob one window at a time and every block goes to a sink as it is made, so a 1 GiB file costs one window
// of memory plus the list of its links, never the file.

import { cidFor, DAG_PB, RAW } from './cid.js'
import { encodeNode, encodeUnixfs, UNIXFS_DIRECTORY, UNIXFS_FILE } from './dagpb.js'

export const CHUNK_SIZE = 262144
export const MAX_LINKS = 174
export const MAX_DIRECTORY_ENTRIES = 1000
/** Kubo turns a directory into a HAMT shard when its links, name plus CID, add up to more than this; Share refuses from it. */
export const DIRECTORY_ESTIMATE_LIMIT = 262144
/** A CIDv1 with sha2-256, as a link holds it. */
const LINK_CID_BYTES = 36
const MAX_NAME_BYTES = 255
const READ_WINDOW = 1048576

const encoder = new TextEncoder()

/**
 * Receives each block as it is made. The bytes may be a view of a larger buffer: keep a copy to keep them.
 * @typedef {(cid: string, bytes: Uint8Array) => void | Promise<void>} BlockSink
 * @typedef {object} ImportOptions
 * @property {number} [chunkSize] bytes per leaf; Kubo's default unless a test says otherwise
 * @property {AbortSignal} [signal]
 * @property {(bytes: number) => void} [onBytes] called with the file bytes just read
 * @typedef {{ size: number, read: (start: number, end: number) => Promise<Uint8Array> }} Source
 * @typedef {{ cid: string, size: number, bytes: number, blocks: number }} Imported
 * One built node as its parent links it: `fileSize` is the file bytes below it, `tsize` the encoded DAG size below
 * and including it.
 * @typedef {{ cid: import('./cid.js').Cid, fileSize: number, tsize: number }} Built
 */

/** @param {Blob | Uint8Array} content @returns {Source} */
function sourceOf (content) {
  if (content instanceof Uint8Array) return { size: content.length, read: async (start, end) => content.subarray(start, end) }
  return { size: content.size, read: async (start, end) => new Uint8Array(await content.slice(start, end).arrayBuffer()) }
}

/** Counts the blocks it hands on. @param {BlockSink} sink */
function counting (sink) {
  const counter = { blocks: 0 }
  /** @type {BlockSink} */
  const wrapped = async (cid, bytes) => { counter.blocks += 1; await sink(cid, bytes) }
  return { counter, wrapped }
}

/** @param {BlockSink} sink @param {number} codec @param {Uint8Array} bytes */
async function putBlock (sink, codec, bytes) {
  const cid = await cidFor(codec, bytes)
  await sink(cid.string, bytes)
  return cid
}

/** @param {Source} source @param {BlockSink} sink @param {ImportOptions} options @returns {Promise<Built>} */
async function buildFile (source, sink, options) {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE
  const window = chunkSize * Math.max(1, Math.floor(READ_WINDOW / chunkSize))
  /** @type {Built[]} */
  let level = []
  if (source.size === 0) level.push({ cid: await putBlock(sink, RAW, new Uint8Array(0)), fileSize: 0, tsize: 0 })
  for (let at = 0; at < source.size; at += window) {
    options.signal?.throwIfAborted()
    const bytes = await source.read(at, Math.min(at + window, source.size))
    if (bytes.length !== Math.min(window, source.size - at)) throw new Error('A file changed while it was being read. Pick it again.')
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize)
      level.push({ cid: await putBlock(sink, RAW, chunk), fileSize: chunk.length, tsize: chunk.length })
    }
    options.onBytes?.(bytes.length)
  }
  while (level.length > 1) {
    /** @type {Built[]} */
    const next = []
    for (let at = 0; at < level.length; at += MAX_LINKS) {
      next.push(await buildFileNode(level.slice(at, at + MAX_LINKS), sink))
    }
    level = next
  }
  return /** @type {Built} */ (level[0])
}

/** @param {Built[]} children @param {BlockSink} sink @returns {Promise<Built>} */
async function buildFileNode (children, sink) {
  const fileSize = children.reduce((sum, child) => sum + child.fileSize, 0)
  const data = encodeUnixfs({
    type: UNIXFS_FILE, filesize: fileSize, blocksizes: children.map((child) => child.fileSize)
  })
  const links = children.map((child) => ({ hash: child.cid.bytes, name: '', tsize: child.tsize }))
  const node = encodeNode(links, data)
  const cid = await putBlock(sink, DAG_PB, node)
  return { cid, fileSize, tsize: node.length + children.reduce((sum, child) => sum + child.tsize, 0) }
}

/** A single file: its blocks go to `sink`. @param {Blob | Uint8Array} content @param {BlockSink} sink @param {ImportOptions} [options] @returns {Promise<Imported>} */
export async function importContent (content, sink, options = {}) {
  const { counter, wrapped } = counting(sink)
  const source = sourceOf(content)
  const built = await buildFile(source, wrapped, options)
  return { cid: built.cid.string, size: built.tsize, bytes: source.size, blocks: counter.blocks }
}

/** A single file's blocks and root CID. @param {Uint8Array} bytes */
export async function importFile (bytes) {
  const blocks = /** @type {Map<string, Uint8Array>} */ (new Map())
  const imported = await importContent(bytes, (cid, block) => { blocks.set(cid, block) })
  return { cid: imported.cid, blocks, size: imported.size }
}

/**
 * @typedef {{ files: Map<string, Source>, dirs: Map<string, DirTree> }} DirTree
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
    if (encoder.encode(segment).length > MAX_NAME_BYTES) throw new Error(`a name is longer than ${MAX_NAME_BYTES} bytes: ${segment.slice(0, 40)}…`)
  }
  return segments
}

/**
 * Whether Kubo would keep a directory flat. `names` are its entries' names; `label` is how the directory is called
 * to a person. Returns the sentence that says why not, or null.
 * @param {string} label @param {string[]} names @returns {string | null}
 */
export function directoryProblem (label, names) {
  const where = label === '' ? 'The top level' : `The folder "${label}"`
  if (names.length > MAX_DIRECTORY_ENTRIES) {
    return `${where} holds ${names.length} items, and a share holds ${MAX_DIRECTORY_ENTRIES} in one folder at most. Put them in smaller folders.`
  }
  let estimate = 0
  for (const name of names) estimate += encoder.encode(name).length + LINK_CID_BYTES
  if (estimate >= DIRECTORY_ESTIMATE_LIMIT) {
    return `The names of the items in ${where.toLowerCase()} are too long together (${Math.round(estimate / 1024)} KiB, the limit is ${DIRECTORY_ESTIMATE_LIMIT / 1024} KiB). Shorten them or put the items in smaller folders.`
  }
  return null
}

/** @param {{ path: string, content: Blob | Uint8Array }[]} files @returns {DirTree} */
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
    dir.files.set(name, sourceOf(file.content))
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

/** @param {DirTree} tree @param {string} label @param {BlockSink} sink @param {ImportOptions} options @returns {Promise<Built>} */
async function buildDirectory (tree, label, sink, options) {
  const problem = directoryProblem(label, [...tree.files.keys(), ...tree.dirs.keys()])
  if (problem !== null) throw new Error(problem)
  /** @type {{ name: string, key: Uint8Array, built: Built }[]} */
  const entries = []
  for (const [name, source] of tree.files) {
    entries.push({ name, key: encoder.encode(name), built: await buildFile(source, sink, options) })
  }
  for (const [name, child] of tree.dirs) {
    entries.push({ name, key: encoder.encode(name), built: await buildDirectory(child, label === '' ? name : `${label}/${name}`, sink, options) })
  }
  entries.sort((a, b) => compareBytes(a.key, b.key))
  const links = entries.map((entry) => ({ hash: entry.built.cid.bytes, name: entry.name, tsize: entry.built.tsize }))
  const node = encodeNode(links, encodeUnixfs({ type: UNIXFS_DIRECTORY, blocksizes: [] }))
  const cid = await putBlock(sink, DAG_PB, node)
  return { cid, fileSize: 0, tsize: node.length + entries.reduce((sum, entry) => sum + entry.built.tsize, 0) }
}

/**
 * A directory of files, `/`-separated relative paths, nested directories made from the paths. Its blocks go to
 * `sink` as they are made; a block two files share is handed over each time it comes up.
 * @param {{ path: string, content: Blob | Uint8Array }[]} files
 * @param {BlockSink} sink
 * @param {ImportOptions} [options]
 * @returns {Promise<Imported>}
 */
export async function importTree (files, sink, options = {}) {
  const tree = buildTree(files)
  const { counter, wrapped } = counting(sink)
  const built = await buildDirectory(tree, '', wrapped, options)
  return { cid: built.cid.string, size: built.tsize, bytes: files.reduce((sum, file) => sum + (file.content instanceof Uint8Array ? file.content.length : file.content.size), 0), blocks: counter.blocks }
}

/**
 * A directory of files held in memory, with every block kept.
 * @param {{ path: string, bytes: Uint8Array }[]} files
 */
export async function importDirectory (files) {
  const blocks = /** @type {Map<string, Uint8Array>} */ (new Map())
  const imported = await importTree(files.map((file) => ({ path: file.path, content: file.bytes })), (cid, block) => { blocks.set(cid, block) })
  return { cid: imported.cid, blocks, size: imported.size }
}
