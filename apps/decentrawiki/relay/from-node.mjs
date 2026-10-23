// Reads a published wiki out of the IPFS node in the editor page that publishes it, through the Kubo node
// this relay runs beside (`KUBO_RPC`), which the page's node dialed. What a node answers is checked before
// more is fetched: the folder's own block first (its names, the sizes its links declare, the core by its
// known CID), and only then the page and the icon, each bounded. The files then go through the same
// checks as an upload (rules.mjs checkFiles), and must make the very CID asked for.

import { DAG_PB, SHA2_256, bytesEqual, parseCid, readCidBytes, sha256 } from '../page/src/ipfs/cid.js'
import { UNIXFS_DIRECTORY, decodeNode, decodeUnixfs } from '../page/src/ipfs/dagpb.js'
import { ALLOWED_NAMES, CORE_CIDS, LIMITS, Refusal } from './rules.mjs'

const ROOT_BYTES = 64 * 1024
/** What a file's dag-pb framing may add to its declared size. */
const FRAMING = 64 * 1024
const PEER = /^(?:12D3Koo|Qm)[1-9A-HJ-NP-Za-km-z]{40,60}$/

/**
 * A POST to the Kubo RPC API, its body read up to `maxBytes`.
 * @typedef {(path: string, options: { timeoutMs: number, maxBytes: number }) => Promise<Uint8Array>} Kubo
 */

/** @param {string} rpc @returns {Kubo} */
export function kuboClient (rpc) {
  const base = rpc.replace(/\/+$/, '')
  return async (path, { timeoutMs, maxBytes }) => {
    const response = await fetch(`${base}/api/v0/${path}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '')
      throw new KuboError(response.status, text.slice(0, 300))
    }
    /** @type {Uint8Array[]} */
    const chunks = []
    let length = 0
    for await (const chunk of response.body) {
      length += chunk.length
      if (length > maxBytes) throw new Refusal(413, 'This wiki is too large for free pinning. Pin it with your own node or service.')
      chunks.push(chunk)
    }
    return new Uint8Array(Buffer.concat(chunks, length))
  }
}

export class KuboError extends Error {
  /** @param {number} status @param {string} text */
  constructor (status, text) {
    super(`Kubo answered ${status}: ${text}`)
    this.name = 'KuboError'
    this.status = status
  }
}

/** @param {string} peer */
export function isPeerId (peer) {
  return PEER.test(peer)
}

/** Waits until Kubo holds a connection to `peer`. @param {Kubo} kubo @param {string} peer @param {number} waitMs */
export async function waitForPeer (kubo, peer, waitMs) {
  const end = Date.now() + waitMs
  for (;;) {
    const listing = JSON.parse(new TextDecoder().decode(await kubo('swarm/peers', { timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 })))
    if (Array.isArray(listing?.Peers) && listing.Peers.some((/** @type {{ Peer?: string }} */ p) => p?.Peer === peer)) return
    if (Date.now() >= end) {
      throw new Refusal(409, 'The IPFS node in your editor page is not connected to Orivon\'s node. Keep the editor open and try again.')
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Fetches `cid`, a published wiki's folder, block by block from what is checked so far.
 * @param {Kubo} kubo @param {string} cid
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readWiki (kubo, cid) {
  const parsed = parseCid(cid)
  if (parsed.codec !== DAG_PB || parsed.hashCode !== SHA2_256) throw new Refusal(400, 'A wiki is one folder of files.')
  const root = await fetchStep(() => kubo(`block/get?arg=${cid}`, { timeoutMs: 45_000, maxBytes: ROOT_BYTES }))
  if (!bytesEqual(await sha256(root), parsed.digest)) throw new Refusal(400, 'The node answered with something other than this wiki.')
  const node = decodeNode(root)
  const unixfs = node.data === undefined ? undefined : decodeUnixfs(node.data)
  if (unixfs?.type !== UNIXFS_DIRECTORY) throw new Refusal(400, 'A wiki is one folder of files.')

  /** @type {Map<string, { cid: string, tsize: number }>} */
  const links = new Map()
  for (const link of node.links) {
    const name = link.name ?? ''
    if (!ALLOWED_NAMES.has(name)) throw new Refusal(400, `${name === '' ? 'A file with no name' : name} is not part of a DecentraWiki wiki, so this relay does not pin it.`)
    if (links.has(name)) throw new Refusal(400, `${name} is in the wiki twice.`)
    links.set(name, { cid: readCidBytes(link.hash).cid.string, tsize: link.tsize ?? 0 })
  }
  const page = links.get('index.html')
  if (page === undefined) throw new Refusal(400, 'A wiki has an index.html.')
  if (page.tsize > LIMITS.pageBytes + FRAMING) throw new Refusal(413, 'This wiki is too large for free pinning. Pin it with your own node or service.')
  const icon = links.get('favicon.ico')
  if (icon !== undefined && icon.tsize > LIMITS.iconBytes + FRAMING) throw new Refusal(413, 'The wiki\'s icon is too large.')
  const cores = [...links].filter(([name]) => name in CORE_CIDS)
  if (cores.length !== 1) throw new Refusal(400, 'A wiki loads one TiddlyWiki core this relay knows.')
  const [coreName, core] = /** @type {[string, { cid: string, tsize: number }]} */ (cores[0])
  if (core.cid !== CORE_CIDS[/** @type {keyof typeof CORE_CIDS} */ (coreName)]) throw new Refusal(400, `${coreName} is not the TiddlyWiki core it names.`)

  /** @type {Map<string, Uint8Array>} */
  const files = new Map()
  files.set('index.html', await fetchStep(() => kubo(`cat?arg=${page.cid}`, { timeoutMs: 120_000, maxBytes: LIMITS.pageBytes })))
  // The core is the same bytes for every wiki of a version, so the relay's own node already holds it.
  files.set(coreName, await fetchStep(() => kubo(`cat?arg=${core.cid}`, { timeoutMs: 120_000, maxBytes: 8 * 1024 * 1024 })))
  if (icon !== undefined) files.set('favicon.ico', await fetchStep(() => kubo(`cat?arg=${icon.cid}`, { timeoutMs: 60_000, maxBytes: LIMITS.iconBytes })))
  return files
}

/** One fetch through Kubo, its failure said as the editor shows it. @template T @param {() => Promise<T>} step */
async function fetchStep (step) {
  try {
    return await step()
  } catch (error) {
    if (error instanceof Refusal) throw error
    console.error('[relay] reading from the page\'s node failed:', error instanceof Error ? error.message : error)
    throw new Refusal(504, 'Orivon\'s node could not read the wiki from the IPFS node in your editor page. Keep the editor open and try again.')
  }
}
