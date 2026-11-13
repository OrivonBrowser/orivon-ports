// Cuts `site/resolver/census.json`: what Linagee's resolver says about every name that has had a content record, as of one
// block, so the resolver reads only what came after it. Everything is read from chain, through two public nodes that must
// agree on each answer, so anyone can cut it again and get the same file.
//
//   node tools/cut-census.mjs                 cut at the finalized block both nodes share, and write the file
//   node tools/cut-census.mjs --block 12345   cut at that block (the nodes need its state: an archive node, or a recent block)
//   node tools/cut-census.mjs --check         cut again at the file's own block and say whether it is the same file
//   node tools/cut-census.mjs --out PATH      write somewhere else
//
// The nodes come from OG_RPC_A (default https://rpc.mevblocker.io) and OG_RPC_B (default https://gateway.tenderly.co/public/mainnet).
// Each must answer `eth_getLogs` over a wide block range for a rare topic, which most free plans refuse; two that do not agree, or one
// that is down, stop the cut.

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sameAddress } from '../site/sdk/abi.js'
import { ChainError } from '../site/sdk/chain.js'
import { CENSUS_FORMAT, censusEntryOf, readCensus } from '../site/resolver/og-census.js'
import { holderOf, idTopic, nameLogsOf } from '../site/resolver/og-freshness.js'
import { implementationIn, upgradesProblem } from '../site/resolver/og-guard.js'
import { keyOf, parseOgName } from '../site/resolver/og-name.js'
import { CENSUS_KEYS, DEPLOY_BLOCKS, IMPLEMENTATION, IMPLEMENTATION_SLOT, PROXY, REGISTRY, TOPICS, WRAPPER } from '../site/resolver/og-pins.js'
import { readName } from '../site/resolver/og-state.js'
import { agreeingChain, rpcChain } from './rpc-chain.mjs'

/** @typedef {import('../site/sdk/chain.js').Chain} Chain */
/** @typedef {import('../site/sdk/chain.js').Log} Log */

export const DEFAULT_NODES = Object.freeze(['https://rpc.mevblocker.io', 'https://gateway.tenderly.co/public/mainnet'])
export const CENSUS_FILE = fileURLToPath(new URL('../site/resolver/census.json', import.meta.url))

/** The widest range asked first, and the narrowest a node that refuses it is asked down to. */
const FIRST_RANGE = 4_000_000
const LEAST_RANGE = 2_000

/**
 * Every log of a filter from one block to another: asked as one range, or as halves when a node refuses the range (too wide, or
 * too many logs). A node that refuses the narrowest range is down for this purpose, and the cut stops.
 * @param {Chain} chain
 * @param {{ address: string | string[], topics: (string | null)[], from: number, to: number }} filter
 * @param {number} [range]
 * @returns {Promise<Log[]>}
 */
export async function pagedLogs (chain, filter, range = FIRST_RANGE) {
  /** @type {Log[]} */
  const found = []
  for (let from = filter.from; from <= filter.to;) {
    const to = Math.min(from + range - 1, filter.to)
    try {
      found.push(...await chain.getLogs({ fromBlock: from, toBlock: to, address: filter.address, topics: filter.topics }))
      from = to + 1
    } catch (error) {
      if (!(error instanceof ChainError) || error.reason !== 'limit' || range <= LEAST_RANGE) throw error
      range = Math.max(LEAST_RANGE, Math.floor(range / 2))
    }
  }
  return found.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
}

/**
 * The label a registry key stands for: its bytes up to the zeros that pad them, as text. Null for a key that is not `keyOf` of an
 * `.og` label this resolver answers.
 * @param {string} key
 */
export function labelOfKey (key) {
  const bytes = key.slice(2).replace(/(?:00)+$/, '')
  if (bytes.length === 0 || bytes.length % 2 !== 0) return null
  let label
  try {
    label = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes.match(/../g) ?? [], (pair) => parseInt(pair, 16)))
  } catch {
    return null
  }
  return parseOgName(`${label}.og`) === label && keyOf(label) === key.toLowerCase() ? label : null
}

/**
 * The census at one block.
 * @param {Chain} chain two nodes that agree (`agreeingChain`), or one in a test
 * @param {{ block: number }} request
 * @param {(line: string) => void} [say]
 */
export async function cutCensus (chain, { block }, say = () => {}) {
  const head = await chain.getBlock(block)
  if (head === null) throw new Error(`the nodes have no block ${block}`)
  const upgradeLogs = await pagedLogs(chain, { address: PROXY, topics: [TOPICS.upgraded], from: DEPLOY_BLOCKS.proxy, to: block })
  const upgrades = upgradeLogs.map((log) => ({ block: log.blockNumber, logIndex: log.logIndex, implementation: `0x${(log.topics[1] ?? '').slice(26)}` }))
  const implementation = implementationIn(await chain.getStorageAt(PROXY, IMPLEMENTATION_SLOT, block))
  if (!sameAddress(implementation, IMPLEMENTATION)) throw new Error(`the proxy runs ${implementation} at block ${block}, not the implementation this resolver is built for (${IMPLEMENTATION})`)
  const problem = upgradesProblem(upgrades)
  if (problem !== null) throw new Error(`the upgrades of the proxy are not the ones this resolver is built for: ${problem}`)
  say(`${upgrades.length} upgrades of the resolver contract, the pinned ones, ending at the pinned implementation`)

  const written = await pagedLogs(chain, { address: PROXY, topics: [TOPICS.setTextRecord], from: DEPLOY_BLOCKS.proxy, to: block })
  const labels = [...new Set(written.map((log) => labelOfKey((log.topics[1] ?? '').toLowerCase())))].filter((label) => label !== null).sort()
  say(`${written.length} SetTextRecord logs, on ${labels.length} names this resolver can answer`)

  /** @type {Record<string, import('../site/resolver/og-census.js').NameEntry>} */
  const names = {}
  for (const label of /** @type {string[]} */ (labels)) {
    const key = keyOf(label)
    const reads = await readName(chain, key, block, CENSUS_KEYS)
    const { found, wrapped } = holderOf(key, reads)
    if (!found) continue
    const named = (await pagedLogs(chain, { address: [REGISTRY, PROXY], topics: [null, key], from: DEPLOY_BLOCKS.registry, to: block }))
      .filter((log) => (log.topics[1] ?? '').toLowerCase() === key && [TOPICS.changed, TOPICS.setTextRecord, TOPICS.newController].includes((log.topics[0] ?? '').toLowerCase()))
    const moved = wrapped
      ? (await pagedLogs(chain, { address: WRAPPER, topics: [TOPICS.transfer, null, null, idTopic(reads.nameToId)], from: DEPLOY_BLOCKS.wrapper, to: block }))
          .filter((log) => (log.topics[0] ?? '').toLowerCase() === TOPICS.transfer)
      : []
    const entry = censusEntryOf(key, reads, nameLogsOf(named, moved))
    if (entry !== null) {
      names[label] = entry
      say(`${label}: ${Object.entries(entry.keys).map(([name, one]) => `${name} ${one.counts ? 'counts' : one.reason}`).join(', ')}`)
    }
  }
  return { format: CENSUS_FORMAT, block: head.number, blockHash: head.hash, implementation: IMPLEMENTATION, upgrades, names }
}

/** The file's text for a census: two-space JSON, so a cut at the same block is the same bytes. @param {object} census */
export const censusText = (census) => `${JSON.stringify(census, null, 2)}\n`

/**
 * The newest block both nodes call finalized. `cutCensus` asks both for its hash and stops if they differ.
 * @param {Chain[]} nodes
 */
async function sharedFinalized (nodes) {
  const heads = await Promise.all(nodes.map((node) => node.getBlock('finalized')))
  const numbers = heads.map((head) => head?.number ?? 0)
  const lowest = Math.min(...numbers)
  if (lowest === 0) throw new Error('a node has no finalized block')
  return lowest
}

/** @param {string[]} argv @param {string} flag */
const flagValue = (argv, flag) => { const at = argv.indexOf(flag); return at < 0 ? undefined : argv[at + 1] }

/** @param {string[]} argv */
export async function main (argv) {
  const urls = [process.env['OG_RPC_A'] ?? DEFAULT_NODES[0], process.env['OG_RPC_B'] ?? DEFAULT_NODES[1]].map(String)
  const nodes = urls.map((url) => rpcChain(url))
  const chain = agreeingChain(/** @type {Chain} */ (nodes[0]), /** @type {Chain} */ (nodes[1]), { names: [urls[0] ?? 'node A', urls[1] ?? 'node B'] })
  const out = flagValue(argv, '--out') ?? CENSUS_FILE
  const say = (/** @type {string} */ line) => { console.error(line) }
  if (argv.includes('--check')) {
    const current = await readFile(out, 'utf8')
    const census = await cutCensus(chain, { block: readCensus(JSON.parse(current)).block }, say)
    const same = censusText(census) === current
    console.error(same ? 'the census is what the chain gives' : 'the census differs from what the chain gives')
    return same ? 0 : 1
  }
  const asked = flagValue(argv, '--block')
  const block = asked === undefined ? await sharedFinalized(/** @type {Chain[]} */ (nodes)) : Number(asked)
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error(`${String(asked)} is not a block number`)
  const census = await cutCensus(chain, { block }, say)
  await writeFile(out, censusText(census))
  console.error(`wrote ${out} at block ${census.block}, hash ${census.blockHash}`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
