// The mutable file system, kept as a tree in memory over UnixFS blocks in the node. A write stores the file's blocks
// at once; directories are rebuilt and stored at flush, root last, then the root is pinned and the root before it is
// unpinned, and its CID is kept in the state file so the next run opens the same tree. Operations run one at a time,
// and a flush asked while others are queued covers all of them.

import { CID } from 'multiformats/cid'
import { fromNode } from '../errors.js'
import { canonical, nodeBlockstore, parseCid, parseIpfsPath } from '../ipfs.js'
import { NodeError } from '../node-client.js'
import { KuboError } from '../wire.js'
import { importFile } from './content.js'
import { describe, encodeDirectory, readDirectory } from './dag.js'

const BLOCK_CACHE_ENTRIES = 256
const ZERO_LENGTH = new Uint8Array(0)

/** @typedef {ReturnType<typeof import('../node-client.js').createNodeClient>} NodeClient */

/**
 * One name in the tree. A directory with `cid` null has changes not stored yet; `children` is null until its links
 * are read; a `type` of `unknown` is a link whose block has not been looked at.
 * @typedef {object} Entry
 * @property {'unknown' | 'file' | 'directory'} type
 * @property {CID | null} cid
 * @property {bigint} tsize
 * @property {number} size
 * @property {number} blocks
 * @property {Map<string, Entry> | null} children
 */

const notFound = () => new KuboError('file does not exist')

/** @returns {Entry} */
const newDirectory = () => ({ type: 'directory', cid: null, tsize: 0n, size: 0, blocks: 0, children: new Map() })

/** @param {CID} cid @param {bigint} tsize @returns {Entry} */
const link = (cid, tsize) => ({ type: 'unknown', cid, tsize, size: 0, blocks: 0, children: null })

/** The entries of a directory the walk has loaded. @param {Entry | undefined} directory */
function childrenOf (directory) {
  if (directory?.children == null) throw new KuboError('not a directory')
  return directory.children
}

/** The parts of an MFS path. @param {string} path */
function segmentsOf (path) {
  if (!path.startsWith('/')) throw new KuboError('paths must start with a leading slash')
  /** @type {string[]} */
  const segments = []
  for (const part of path.split('/')) {
    if (part === '..') segments.pop()
    else if (part !== '' && part !== '.') segments.push(part)
  }
  return segments
}

/**
 * @param {{ node: NodeClient, pins: ReturnType<typeof import('../pins.js').createPinQueue>, state: import('../state.js').State }} deps
 */
export function createMfs ({ node, pins, state }) {
  /** @type {Map<string, Uint8Array>} */
  const blocks = new Map()
  /** @type {Entry | null} */
  let root = null
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve()
  /** @type {Promise<string> | null} */
  let flushing = null

  /** One operation at a time, its failures worded as kubo words them. @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  function locked (job) {
    const run = tail.then(job).catch((error) => { throw fromNode(error, { notFound: 'file does not exist' }) })
    tail = run.catch(() => {})
    return run
  }

  /** @param {CID} cid */
  async function fetchBlock (cid) {
    const key = cid.toString()
    const cached = blocks.get(key)
    if (cached !== undefined) return cached
    const bytes = await node.getBlock(key)
    remember(key, bytes)
    return bytes
  }

  /** @param {string} key @param {Uint8Array} bytes */
  function remember (key, bytes) {
    blocks.delete(key)
    blocks.set(key, bytes)
    if (blocks.size > BLOCK_CACHE_ENTRIES) blocks.delete(/** @type {string} */ (blocks.keys().next().value))
  }

  /** The tree as last flushed, or an empty one when nothing was kept or the kept root is gone from the node. */
  async function loadRoot () {
    if (root !== null) return root
    const saved = state.mfsRoot
    if (saved !== undefined) {
      const entry = link(parseCid(saved), 0n)
      try {
        await resolve(entry)
        if (entry.type === 'directory') root = entry
      } catch (error) {
        if (!(error instanceof NodeError && error.status === 404)) throw error
      }
    }
    root ??= newDirectory()
    return root
  }

  /** @param {Entry} entry */
  async function resolve (entry) {
    if (entry.type !== 'unknown' || entry.cid === null) return entry
    const found = await describe(entry.cid, fetchBlock)
    entry.type = found.type
    entry.size = found.size
    entry.blocks = found.blocks
    if (entry.tsize === 0n) entry.tsize = found.tsize
    return entry
  }

  /** A directory's entries, read from its block the first time. @param {Entry} directory @returns {Promise<Map<string, Entry>>} */
  async function load (directory) {
    if (directory.children !== null) return directory.children
    if (directory.cid === null) throw new KuboError('the directory has no block to read')
    const read = await readDirectory(directory.cid, fetchBlock)
    directory.children = new Map(read.links.map((one) => [one.name, link(one.cid, one.tsize)]))
    directory.blocks = read.rootLinks
    return directory.children
  }

  /**
   * Walks `segments` from the root (or `from`), returning the directories passed through and the entry at the end,
   * undefined when only the last name is missing. With `parents` the directories on the way are made.
   * @param {string[]} segments @param {{ parents?: boolean, from?: Entry }} [options]
   * @returns {Promise<{ chain: Entry[], entry: Entry | undefined }>}
   */
  async function lookup (segments, { parents = false, from } = {}) {
    let entry = from ?? await loadRoot()
    /** @type {Entry[]} */
    const chain = []
    for (const [index, name] of segments.entries()) {
      await resolve(entry)
      if (entry.type !== 'directory') throw notFound()
      const children = await load(entry)
      chain.push(entry)
      let next = children.get(name)
      if (next === undefined) {
        if (index === segments.length - 1) return { chain, entry: undefined }
        if (!parents) throw notFound()
        next = newDirectory()
        children.set(name, next)
      }
      entry = next
    }
    return { chain, entry: await resolve(entry) }
  }

  /** What a path names: in the tree, or under `/ipfs/<cid>`, which is read and never changed. @param {string} path */
  async function locate (path) {
    if (path.startsWith('/ipfs/')) {
      const { root: cid, segments } = parseIpfsPath(path)
      const { entry } = await lookup(segments, { from: link(parseCid(cid), 0n) })
      if (entry === undefined) throw notFound()
      return { entry, name: segments.at(-1) ?? cid }
    }
    const segments = segmentsOf(path)
    const { entry } = await lookup(segments)
    if (entry === undefined) throw notFound()
    return { entry, name: segments.at(-1) ?? '' }
  }

  /** @param {Entry[]} chain */
  function touch (chain) {
    for (const directory of chain) directory.cid = null
  }

  /** Stores every changed directory, deepest first, so each holds its children's CIDs. @param {Entry} directory @returns {Promise<void>} */
  async function commit (directory) {
    if (directory.cid !== null || directory.children === null) return
    const links = []
    for (const [name, child] of directory.children) {
      if (child.type === 'directory') await commit(child)
      links.push({ name, cid: /** @type {CID} */ (child.cid), tsize: child.tsize })
    }
    const encoded = await encodeDirectory(links, 1)
    const store = nodeBlockstore(node)
    for (const block of encoded.blocks) {
      await store.put(block.cid, block.bytes)
      remember(block.cid.toString(), block.bytes)
    }
    directory.cid = encoded.cid
    directory.tsize = encoded.tsize
    directory.blocks = encoded.rootLinks
  }

  /** The root stored, as a CID. */
  async function commitRoot () {
    const top = await loadRoot()
    await commit(top)
    return /** @type {CID} */ (top.cid)
  }

  /** Pins the stored root and lets go of the ones it replaced, listed in the state so a failed unpin is tried again. */
  async function publish () {
    const cid = canonical(await commitRoot())
    const previous = state.mfsRoot
    if (cid !== previous) {
      await pins.pin(cid)
      const stale = new Set([...state.stalePins, ...(previous === undefined ? [] : [previous])])
      stale.delete(cid)
      await state.update({ mfsRoot: cid, stalePins: [...stale] })
    }
    for (const old of state.stalePins) {
      await pins.unpin(old)
      await state.update({ stalePins: state.stalePins.filter((one) => one !== old) })
    }
    return cid
  }

  /** One flush for every operation queued before it runs. */
  function requestFlush () {
    flushing ??= locked(async () => {
      flushing = null
      return publish()
    })
    return flushing
  }

  /** @param {Entry} entry */
  async function readAll (entry) {
    return new Uint8Array(await (await node.cat(/** @type {CID} */ (entry.cid).toString())).arrayBuffer())
  }

  /**
   * Where a name goes: inside `destination` when that is a directory, else as `destination` itself.
   * @param {string} destination @param {string} name @param {boolean} parents @param {boolean} [mustBeDirectory]
   */
  async function target (destination, name, parents, mustBeDirectory = false) {
    const segments = segmentsOf(destination)
    const { chain, entry } = await lookup(segments, { parents })
    if (entry?.type === 'directory') {
      const children = await load(entry)
      if (children.has(name)) throw new KuboError('directory already has entry by that name')
      return { chain: [...chain, entry], parent: entry, name }
    }
    if (entry !== undefined) throw new KuboError('directory already has entry by that name')
    if (mustBeDirectory) throw new KuboError('the destination must be an existing directory when several sources are given')
    const parent = chain.at(-1)
    const last = segments.at(-1)
    if (parent === undefined || last === undefined) throw notFound()
    return { chain, parent, name: last }
  }

  return {
    /**
     * @param {string} path @param {Uint8Array} bytes
     * @param {{ offset?: number, create?: boolean, truncate?: boolean, parents?: boolean, flush?: boolean, version?: 0 | 1, rawLeaves?: boolean }} [options]
     */
    async write (path, bytes, { offset = 0, create = false, truncate = false, parents = false, flush = true, version = 1, rawLeaves = version === 1 } = {}) {
      await locked(async () => {
        if (offset < 0) throw new KuboError('cannot have negative write offset')
        const segments = segmentsOf(path)
        const { chain, entry } = await lookup(segments, { parents: parents && create })
        const parent = chain.at(-1)
        const name = segments.at(-1)
        if (parent === undefined || name === undefined) throw new KuboError('cannot write to a directory')
        if (entry === undefined && !create) throw notFound()
        if (entry?.type === 'directory') throw new KuboError('cannot write to a directory')
        const before = entry === undefined || truncate ? ZERO_LENGTH : await readAll(entry)
        const joined = new Uint8Array(Math.max(before.length, offset + bytes.length))
        joined.set(before)
        joined.set(bytes, offset)
        const file = await importFile(node, joined, { version, rawLeaves })
        childrenOf(parent).set(name, { type: 'file', cid: file.cid, tsize: file.tsize, size: file.size, blocks: file.blocks, children: null })
        touch(chain)
      })
      if (flush) await requestFlush()
    },

    /** @param {string} path @param {{ parents?: boolean, flush?: boolean }} [options] */
    async mkdir (path, { parents = false, flush = true } = {}) {
      await locked(async () => {
        const segments = segmentsOf(path)
        const { chain, entry } = await lookup(segments, { parents })
        if (entry !== undefined) {
          if (entry.type === 'directory' && parents) return
          throw new KuboError('file already exists')
        }
        const parent = chain.at(-1)
        const name = segments.at(-1)
        if (parent === undefined || name === undefined) throw notFound()
        childrenOf(parent).set(name, newDirectory())
        touch(chain)
      })
      if (flush) await requestFlush()
    },

    /** @param {string[]} paths @param {{ recursive?: boolean, force?: boolean, flush?: boolean }} [options] */
    async rm (paths, { recursive = false, force = false, flush = true } = {}) {
      await locked(async () => {
        for (const path of paths) {
          const segments = segmentsOf(path)
          if (segments.length === 0) throw new KuboError('cannot delete the root')
          let found
          try {
            found = await lookup(segments)
          } catch (error) {
            if (force && error instanceof KuboError && error.message === 'file does not exist') continue
            throw error
          }
          const { chain, entry } = found
          if (entry === undefined) {
            if (force) continue
            throw notFound()
          }
          if (entry.type === 'directory' && !recursive) throw new KuboError(`${path} is a directory, use -r to remove directories`)
          childrenOf(chain.at(-1)).delete(/** @type {string} */ (segments.at(-1)))
          touch(chain)
        }
      })
      if (flush) await requestFlush()
    },

    /** @param {string[]} sources @param {string} destination @param {{ parents?: boolean, flush?: boolean }} [options] */
    async mv (sources, destination, { parents = false, flush = true } = {}) {
      await locked(async () => {
        for (const source of sources) {
          const from = segmentsOf(source)
          const name = from.at(-1)
          if (name === undefined) throw new KuboError('cannot move the root')
          const { chain: fromChain, entry } = await lookup(from)
          if (entry === undefined) throw notFound()
          const into = segmentsOf(destination)
          if (entry.type === 'directory' && into.length >= from.length && from.every((part, index) => into[index] === part)) {
            throw new KuboError('cannot move a directory into itself')
          }
          const placed = await target(destination, name, parents, sources.length > 1)
          childrenOf(fromChain.at(-1)).delete(name)
          touch(fromChain)
          childrenOf(placed.parent).set(placed.name, entry)
          touch(placed.chain)
        }
      })
      if (flush) await requestFlush()
    },

    /** Copies by linking: the same CID under a second name. @param {string[]} sources @param {string} destination @param {{ parents?: boolean, flush?: boolean }} [options] */
    async cp (sources, destination, { parents = false, flush = true } = {}) {
      await locked(async () => {
        for (const source of sources) {
          const { entry, name } = await locate(source)
          await commit(entry)
          const placed = await target(destination, name, parents, sources.length > 1)
          childrenOf(placed.parent).set(placed.name, { ...entry, children: null })
          touch(placed.chain)
        }
      })
      if (flush) await requestFlush()
    },

    /** @param {string} path */
    stat (path) {
      return locked(async () => {
        const { entry } = await locate(path)
        await commit(entry)
        const cid = /** @type {CID} */ (entry.cid)
        return { cid: cid.toString(), type: entry.type, size: entry.size, tsize: entry.tsize, blocks: entry.blocks }
      })
    },

    /** The entries of a directory, or the file itself. @param {string} path */
    ls (path) {
      return locked(async () => {
        const { entry, name } = await locate(path)
        const one = (/** @type {string} */ at, /** @type {Entry} */ item) => ({ name: at, type: item.type, size: item.size, cid: /** @type {CID} */ (item.cid).toString() })
        if (entry.type !== 'directory') return [one(name, entry)]
        const children = [...(await load(entry)).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        for (const [, child] of children) {
          await resolve(child)
          await commit(child)
        }
        return children.map(([at, child]) => one(at, child))
      })
    },

    /** The file's bytes from the node, as its response. @param {string} path @param {{ offset?: number, length?: number, signal?: AbortSignal }} [range] */
    read (path, range = {}) {
      return locked(async () => {
        const { entry } = await locate(path)
        if (entry.type === 'directory') throw new KuboError('this dag node is a directory')
        return node.cat(/** @type {CID} */ (entry.cid).toString(), range)
      })
    },

    /** Stores and pins the tree, then answers the CID at `path`. @param {string} [path] */
    async flush (path = '/') {
      const rootCid = await requestFlush()
      if (path === '/' || segmentsOf(path).length === 0) return rootCid
      return locked(async () => String(/** @type {CID} */ ((await locate(path)).entry.cid)))
    },

    /** Resolves once every operation asked so far is done. */
    settle () {
      return tail.then(() => undefined)
    }
  }
}
