// Reads a published wiki out of the IPFS node in the editor page that publishes it, through the Kubo node
// this relay runs beside (`KUBO_RPC`), which the page's node dialed, or out of the IPFS network through the
// same Kubo node when a name is kept for a version nobody uploaded. What a node answers is checked before
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
 * A POST to the Kubo RPC API, its answer read up to `maxBytes`; `body` is sent with its `contentType`, as
 * Kubo takes the file argument of `routing/put`.
 * @typedef {(path: string, options: { timeoutMs: number, maxBytes: number, body?: Uint8Array, contentType?: string }) => Promise<Uint8Array>} Kubo
 */

/** @param {string} rpc @returns {Kubo} */
export function kuboClient (rpc) {
  const base = rpc.replace(/\/+$/, '')
  return async (path, { timeoutMs, maxBytes, body, contentType }) => {
    const response = await fetch(`${base}/api/v0/${path}`, {
      method: 'POST',
      ...(body === undefined ? {} : { body, headers: { 'content-type': contentType ?? 'application/octet-stream' } }),
      signal: AbortSignal.timeout(timeoutMs)
    })
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

/**
 * Whether `addr` is `/ip4/<a>/tcp/<port>/p2p/<id>` or the `/ip6/` form, at a public unicast address: IPv4 outside
 * the reserved ranges, IPv6 in 2000::/3 outside documentation addresses.
 * @param {string} addr
 */
export function isPublicTcp (addr) {
  const match = /^\/(ip4|ip6)\/([^/]+)\/tcp\/\d{1,5}\/p2p\/[1-9A-HJ-NP-Za-km-z]+$/.exec(addr)
  if (match === null) return false
  const host = /** @type {string} */ (match[2])
  if (match[1] === 'ip4') {
    const parts = host.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
    const [a, b, c] = /** @type {[number, number, number, number]} */ (parts)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113))
  }
  const first = Number.parseInt(host.split(':')[0] ?? '', 16)
  return !host.includes('.') && first >= 0x2000 && first < 0x4000 && !/^2001:0?db8:/i.test(host)
}

/** @param {string} peer */
export function isPeerId (peer) {
  return PEER.test(peer)
}

/**
 * Where an editor page's node dials the Kubo node beside the relay: its peer id and its public TCP addresses,
 * which the node's own transports speak.
 * @param {Kubo} kubo
 */
export async function nodeAddress (kubo) {
  const id = JSON.parse(new TextDecoder().decode(await kubo('id', { timeoutMs: 10_000, maxBytes: 1024 * 1024 })))
  const peer = String(id?.ID ?? '')
  const addrs = (Array.isArray(id?.Addresses) ? id.Addresses : [])
    .filter((/** @type {unknown} */ a) => typeof a === 'string' && isPublicTcp(a))
  if (!isPeerId(peer) || addrs.length === 0) throw new Refusal(503, 'Orivon\'s node is not reachable right now. Try again later.')
  return { peer, addrs }
}

/**
 * Waits until Kubo holds a connection to `peer`, and answers the address it sees it at.
 * @param {Kubo} kubo @param {string} peer @param {number} waitMs @returns {Promise<string>}
 */
export async function waitForPeer (kubo, peer, waitMs) {
  const end = Date.now() + waitMs
  for (;;) {
    const listing = JSON.parse(new TextDecoder().decode(await kubo('swarm/peers', { timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 })))
    const found = Array.isArray(listing?.Peers) ? listing.Peers.find((/** @type {{ Peer?: string }} */ p) => p?.Peer === peer) : undefined
    if (found !== undefined && typeof found.Addr === 'string') return `${found.Addr}/p2p/${peer}`
    if (Date.now() >= end) {
      throw new Refusal(409, 'The IPFS node in your editor page is not connected to Orivon\'s node. Keep the editor open and try again.')
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Runs `read` while Kubo peers with the page's node. Kubo asks a connected peer for blocks only if it
 * peers with it, is on its network or has dealt with it before, and the page's node is none of these;
 * a peering also keeps the connection from being trimmed. It ends when `read` does, however it ends.
 * @template T @param {Kubo} kubo @param {string} peer @param {string} addr @param {() => Promise<T>} read
 */
export async function whilePeered (kubo, peer, addr, read) {
  if (peering.has(peer)) throw new Refusal(429, 'This IPFS node is already being read from. Try again in a minute.')
  peering.add(peer)
  try {
    // A peer Kubo already peers with is the operator's: it is neither added nor, afterwards, removed.
    const listed = JSON.parse(new TextDecoder().decode(await kubo('swarm/peering/ls', { timeoutMs: 10_000, maxBytes: 1024 * 1024 })))
    const already = Array.isArray(listed?.Peers) && listed.Peers.some((/** @type {{ ID?: string }} */ p) => p?.ID === peer)
    if (already) return await read()
    await kubo(`swarm/peering/add?arg=${encodeURIComponent(addr)}`, { timeoutMs: 10_000, maxBytes: 64 * 1024 })
    try {
      return await read()
    } finally {
      await kubo(`swarm/peering/rm?arg=${peer}`, { timeoutMs: 10_000, maxBytes: 64 * 1024 }).catch((error) => {
        console.error(`[relay] could not stop peering with ${peer}:`, error instanceof Error ? error.message : error)
      })
    }
  } finally {
    peering.delete(peer)
  }
}

/** The peers a read is under way from. */
const peering = new Set()

/**
 * What a read that does not finish says, by where the wiki is read from: the editor page's node, which the
 * person can keep open, or the IPFS network, where the version has to be pinned for others to fetch.
 */
const UNREACHED = {
  page: {
    late: 'Orivon\'s node could not read the wiki from the IPFS node in your editor page in time. Keep the editor open and try again.',
    failed: 'Orivon\'s node could not read the wiki from the IPFS node in your editor page. Keep the editor open and try again.',
    log: 'reading from the page\'s node failed:'
  },
  network: {
    late: 'Orivon\'s node could not find this version on IPFS in time, so it does not keep its name. Make sure it is pinned where others can fetch it, and try again in a few minutes.',
    failed: 'Orivon\'s node could not find this version on IPFS, so it does not keep its name. Make sure it is pinned where others can fetch it, and try again in a few minutes.',
    log: 'reading from the IPFS network failed:'
  }
}

/**
 * Fetches `cid`, a published wiki's folder, block by block from what is checked so far.
 * @param {Kubo} kubo @param {string} cid @param {number} [deadline] @param {'page' | 'network'} [from]
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function readWiki (kubo, cid, deadline = Date.now() + 90_000, from = 'page') {
  const words = UNREACHED[from]
  /** At most `ms`, and never past the read's deadline. @param {number} ms */
  const within = (ms) => {
    const left = deadline - Date.now()
    if (left <= 0) throw new Refusal(504, words.late)
    return Math.min(ms, left)
  }
  const parsed = parseCid(cid)
  if (parsed.codec !== DAG_PB || parsed.hashCode !== SHA2_256) throw new Refusal(400, 'A wiki is one folder of files.')
  const root = await fetchStep(words, () => kubo(`block/get?arg=${cid}`, { timeoutMs: within(45_000), maxBytes: ROOT_BYTES }))
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
  // `length` stops Kubo itself, not only the reading here, at one byte past what a check would refuse.
  files.set('index.html', await fetchStep(words, () => kubo(`cat?arg=${page.cid}&length=${LIMITS.pageBytes + 1}`, { timeoutMs: within(120_000), maxBytes: LIMITS.pageBytes })))
  // The core is the same bytes for every wiki of a version, so the relay's own node already holds it.
  files.set(coreName, await fetchStep(words, () => kubo(`cat?arg=${core.cid}&length=${8 * 1024 * 1024 + 1}`, { timeoutMs: within(120_000), maxBytes: 8 * 1024 * 1024 })))
  if (icon !== undefined) files.set('favicon.ico', await fetchStep(words, () => kubo(`cat?arg=${icon.cid}&length=${LIMITS.iconBytes + 1}`, { timeoutMs: within(60_000), maxBytes: LIMITS.iconBytes })))
  return files
}

/** One fetch through Kubo, its failure said as the editor shows it. @template T @param {{ failed: string, log: string }} words @param {() => Promise<T>} step */
async function fetchStep (words, step) {
  try {
    return await step()
  } catch (error) {
    if (error instanceof Refusal) throw error
    console.error(`[relay] ${words.log}`, error instanceof Error ? error.message : error)
    throw new Refusal(504, words.failed)
  }
}
