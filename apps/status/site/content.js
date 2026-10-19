// The content step: the file DAG behind an address, fetched block by block and hash-checked.
// A site is read through its whole index.html; a folder is listed and every file in it is
// spot-checked with its root block and one random leaf, so a large package is sampled, not
// downloaded.

import { cidToString, CODEC, parseCid, parseCidBytes } from './cid.js'
import { decodeDagPb, decodeUnixfs } from './dagpb.js'
import { fetchBlock } from './fetchers.js'

const MAX_DEPTH = 12

/** A fault with a sentence a non-engineer can read. */
class ContentFailure extends Error {}

/** Thrown to unwind work another part of the check has already failed. */
class Stopped extends Error {}

/**
 * @typedef {{
 *   kind: 'site' | 'folder', bytes: number, fileBytes: number | null, blocks: number,
 *   gateways: Record<string, number>, entries: Entry[], checked: number, total: number,
 *   failure: string | null, warn: string | null, ms: number, done: boolean
 * }} Content
 * @typedef {{ name: string, size: number, status: 'pending' | 'ok' | 'failed' | 'skipped', note: string, error?: string }} Entry
 */

/** @returns {Content} */
export function emptyContent (kind) {
  return { kind, bytes: 0, fileBytes: null, blocks: 0, gateways: {}, entries: [], checked: 0, total: 0, failure: null, warn: null, ms: 0, done: false }
}

/** @param {{ hash: Uint8Array }} link */
const linkCid = (link) => cidToString(parseCidBytes(link.hash))

/**
 * @param {import('./fetchers.js').Context} ctx
 * @param {Content} content
 * @param {{ aborted: boolean }} scope
 * @param {string} cid
 * @param {string} what the words for a failure: "the page", "Orivon-0.0.8-x64.dmg"
 */
async function readNode (ctx, content, scope, cid, what) {
  let block
  try {
    block = await fetchBlock(ctx, cid, scope)
  } catch (error) {
    if (scope.aborted) throw new Stopped()
    scope.aborted = true
    throw new ContentFailure(`No gateway could fetch ${what}`)
  }
  content.blocks++
  content.bytes += block.bytes.length
  content.gateways[block.gateway] = (content.gateways[block.gateway] ?? 0) + 1
  const codec = parseCid(cid).codec
  if (codec === CODEC.raw) return { cid, raw: true, bytes: block.bytes, links: [], unixfs: null }
  if (codec !== CODEC.dagPb) throw new ContentFailure(`${what} uses a format this page cannot read`)
  try {
    const node = decodeDagPb(block.bytes)
    return { cid, raw: false, bytes: block.bytes, links: node.links, unixfs: node.data ? decodeUnixfs(node.data) : null }
  } catch {
    throw new ContentFailure(`${what} arrived but is not a readable file tree`)
  }
}

/**
 * Every block of one file, summed. A file's size must equal what its root says.
 * @returns {Promise<number>} the file's bytes
 */
async function walkFile (ctx, content, scope, cid, what) {
  const node = await readNode(ctx, content, scope, cid, what)
  if (node.raw) return node.bytes.length
  const unixfs = node.unixfs
  if (!unixfs || (unixfs.type !== 2 && unixfs.type !== 0)) throw new ContentFailure(`${what} is not a file`)
  if (unixfs.blocksizes.length > 0 && unixfs.blocksizes.length !== node.links.length) throw new ContentFailure(`${what} arrived with a broken block list`)
  const parts = await Promise.all(node.links.map((link) => walkFile(ctx, content, scope, linkCid(link), what)))
  const total = (unixfs.data?.length ?? 0) + parts.reduce((sum, part) => sum + part, 0)
  if (unixfs.filesize !== null && total !== unixfs.filesize) throw new ContentFailure(`${what} arrived incomplete (${total} of ${unixfs.filesize} bytes)`)
  return total
}

/**
 * A file's root block, then one random leaf below it.
 * @returns {Promise<string>} a note on what was sampled
 */
async function spotCheck (ctx, content, name, cid) {
  const scope = { aborted: false }
  let node = await readNode(ctx, content, scope, cid, `the start of ${name}`)
  if (!node.raw && node.unixfs && node.unixfs.type === 1) return 'a folder: its root block only'
  let depth = 0
  while (!node.raw && node.links.length > 0 && depth < MAX_DEPTH) {
    const link = /** @type {{ hash: Uint8Array }} */ (node.links[Math.floor(Math.random() * node.links.length)])
    node = await readNode(ctx, content, scope, linkCid(link), `part of ${name}`)
    depth++
  }
  return depth === 0 ? 'one block, all of it' : `root block and a random block ${depth} level${depth === 1 ? '' : 's'} down`
}

/**
 * Runs the content step for one address.
 * @param {import('./fetchers.js').Context} ctx
 * @param {string} rootCid
 * @param {'site' | 'folder'} kind
 * @param {() => void} [onProgress]
 * @returns {Promise<Content>}
 */
export async function checkContent (ctx, rootCid, kind, onProgress = () => {}) {
  const content = emptyContent(kind)
  const started = performance.now()
  const scope = { aborted: false }
  try {
    const root = await readNode(ctx, content, scope, rootCid, kind === 'site' ? 'the site\'s folder' : 'the folder')
    if (root.raw || !root.unixfs || ![1, 5].includes(root.unixfs.type)) throw new ContentFailure('The published address is a single file, not a folder')
    if (root.unixfs.type === 5) {
      content.warn = 'Sharded folder: not checked'
    } else if (kind === 'site') {
      const index = root.links.find((link) => link.name === 'index.html')
      content.entries = root.links.map((link) => ({ name: link.name, size: link.tsize, status: 'skipped', note: 'not fetched' }))
      if (!index) throw new ContentFailure('The published folder has no index.html')
      content.total = 1
      content.fileBytes = await walkFile(ctx, content, scope, linkCid(index), 'the page (index.html)')
      content.checked = 1
      for (const entry of content.entries) if (entry.name === 'index.html') Object.assign(entry, { status: 'ok', note: `read in full, ${content.blocks - 1} block${content.blocks === 2 ? '' : 's'}` })
    } else {
      content.entries = root.links.map((link) => ({ name: link.name, size: link.tsize, status: 'pending', note: '' }))
      content.total = root.links.length
      onProgress()
      await Promise.all(root.links.map(async (link, i) => {
        const entry = /** @type {Entry} */ (content.entries[i])
        try {
          entry.note = await spotCheck(ctx, content, link.name, linkCid(link))
          entry.status = 'ok'
          content.checked++
        } catch (error) {
          entry.status = 'failed'
          entry.error = error instanceof ContentFailure ? error.message : 'could not be read'
          content.failure ??= entry.error
        }
        onProgress()
      }))
    }
  } catch (error) {
    scope.aborted = true
    if (!(error instanceof Stopped)) content.failure = error instanceof ContentFailure ? error.message : `The content check failed: ${error instanceof Error ? error.message : error}`
  }
  content.ms = performance.now() - started
  content.done = true
  return content
}
