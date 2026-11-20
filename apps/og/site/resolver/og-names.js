// Resolves a name under `.og` from the Linagee contracts on chain: `alice.og` is the registry key `alice`, held by whoever the
// registry (or the wrapper, for a wrapped name) says, with the text records the resolver stores for it. A record counts only
// when the holder could have written it and no one has since taken the name or the controller away (og-freshness.js), and
// only while the resolver contract is the one this bundle was built against (og-guard.js). The registry's own `content` slot is read
// with the rest and answers as an `ipfs` record when a direct `setContent` of its value came after the last change of holder. Every
// read is made at one block. History up to the census checkpoint is the bundle's (og-census.js); the rest, from the checkpoint to that
// block, is read from the node by name, window by window (og-tail.js), within the time the call has, and the transaction behind each
// registry log of the name (what the call was) after it.

import { entryOf, mergedLogs } from './og-census.js'
import { evaluateFreshness, holderOf, idTopic, nameLogsOf } from './og-freshness.js'
import { guardResolver, upgradedScan } from './og-guard.js'
import { keyOf, parseOgName } from './og-name.js'
import { notFound, answerOf } from './og-answer.js'
import { CENSUS_KEYS, PROXY, REGISTRY, REGISTRY_CONTENT, TEXT_KEYS, TOPICS, WRAPPER } from './og-pins.js'
import { decodeRegistryCall, SETTERS } from './og-registry-calls.js'
import { pinBlocks, readName } from './og-state.js'
import { newCall, OgRefusal, readTransactions, scanLogs } from './og-tail.js'

/** @typedef {import('../sdk/chain.js').Chain} Chain */
/** @typedef {import('./og-census.js').Census} Census */
/** @typedef {import('./og-tail.js').Session} Session */
/** @typedef {import('./og-tail.js').Call} Call */
/** @typedef {import('./og-freshness.js').NameLogs} NameLogs */
/** @typedef {import('./og-freshness.js').NameReads} NameReads */
/** @typedef {import('./og-answer.js').Answer} Answer */
/**
 * @typedef {object} Lookup what one call brings
 * @property {Session} session what the page remembers between calls
 * @property {Census} census the bundle's census
 * @property {AbortSignal | undefined} [signal] fires when the call is no longer wanted
 * @property {number | undefined} [deadlineAt] milliseconds since the epoch by which the call must have answered
 * @property {((detail: string, fraction?: number) => void) | undefined} [progress] says what the call is doing, for the loading screen
 */

/** The most census names whose recent history is read when the page starts. */
export const MAX_WARM_NAMES = 64

const NAME_EVENTS = new Set(/** @type {string[]} */ ([TOPICS.changed, TOPICS.setTextRecord, TOPICS.newController]))

/**
 * Every log of the name between the census checkpoint and `block`, by event: the registry's and the resolver's logs that carry the
 * name (one query), and for a wrapped name the wrapper's transfers of its token (a second).
 * @param {Chain} chain
 * @param {Lookup} lookup
 * @param {{ label: string, key: string, tokenId: string | null, block: number, final: number, call: Call }} name
 *   `final`: the highest block whose logs no reorganisation can change, up to which the windows read are kept; `call`: who they are read for
 * @returns {Promise<NameLogs>}
 */
async function scanName (chain, lookup, { label, key, tokenId, block, final, call }) {
  const { session, census, signal, deadlineAt, progress } = lookup
  const from = census.block + 1
  const what = `the recent history of ${label}.og`
  const options = { deadlineAt, signal, progress, what, call, final }
  const tokenTopic = tokenId === null ? null : idTopic(tokenId)
  const named = scanLogs(chain, session, {
    id: `name:${key}`,
    address: [REGISTRY, PROXY],
    topics: [null, key],
    from,
    to: block,
    accept: (log) => log.topics[1]?.toLowerCase() === key && NAME_EVENTS.has(log.topics[0]?.toLowerCase() ?? '') && (log.address.toLowerCase() === REGISTRY.toLowerCase() || log.address.toLowerCase() === PROXY.toLowerCase())
  }, options)
  const transfers = tokenTopic === null
    ? Promise.resolve([])
    : scanLogs(chain, session, {
      id: `token:${tokenId}`,
      address: WRAPPER,
      topics: [TOPICS.transfer, null, null, tokenTopic],
      from,
      to: block,
      accept: (log) => log.address.toLowerCase() === WRAPPER.toLowerCase() && log.topics[0]?.toLowerCase() === TOPICS.transfer && log.topics[3]?.toLowerCase() === tokenTopic
    }, options)
  return nameLogsOf(...(await Promise.all([named, transfers])))
}

/** How many transactions are asked at once: a name's changes number a few, and the newest decide. */
const CALL_ROUND = 4

const ZERO_SLOT = `0x${'0'.repeat(64)}`

/**
 * What each of the name's registry `Changed` logs after the checkpoint did, read from the transactions behind them, newest first and a
 * round at a time, until one is a change of holder: nothing before it can change the answer. The logs come back with `call` filled in.
 * A call that cannot be read is no setter: a transaction the node does not have, or one that could not be read in time, refuses the lookup.
 * @param {Chain} chain
 * @param {Lookup} lookup
 * @param {{ label: string, key: string, tail: NameLogs, final: number, call: Call }} name
 * @returns {Promise<NameLogs>}
 */
async function readCalls (chain, lookup, { label, key, tail, final, call }) {
  const { session, signal, deadlineAt, progress } = lookup
  const newest = [...tail.registryChanged].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
  /** @type {Map<unknown, import('./og-registry-calls.js').RegistryCall | null>} */
  const calls = new Map()
  for (let at = 0; at < newest.length; at += CALL_ROUND) {
    const round = newest.slice(at, at + CALL_ROUND)
    const wanted = round.map((log) => ({ hash: log.transactionHash ?? '', blockNumber: log.blockNumber }))
    const transactions = await readTransactions(chain, session, wanted, { deadlineAt, signal, progress, what: `what the registry did to ${label}.og`, call, final })
    let moved = false
    round.forEach((log, index) => {
      const tx = /** @type {import('../sdk/chain.js').Transaction} */ (transactions[index])
      // A transaction from another block than its log's is not the one that logged it.
      const read = tx.blockNumber === log.blockNumber ? decodeRegistryCall(tx, key) : null
      calls.set(log, read)
      if (read === null || !SETTERS.has(read.fn)) moved = true
    })
    if (moved) break
  }
  return { ...tail, registryChanged: tail.registryChanged.map((log) => calls.has(log) ? { ...log, call: calls.get(log) ?? null } : log) }
}

/**
 * @typedef {object} Inspection a name as the resolver sees it, with the reasons behind every record
 * @property {string} label
 * @property {string} key the registry key
 * @property {number} block the block every read was made at
 * @property {NameReads} reads what the contracts said at `block`
 * @property {{ found: boolean, holder: string | null, wrapped: boolean, stranded: boolean }} holder
 * @property {ReturnType<typeof evaluateFreshness> | null} verdict which keys count and why, and whether the registry's slot does (`registry`); null for a name that is not there, or when `refusal` is set
 * @property {Error | null} refusal why the records could not be vouched for: the resolver contract changed, or the history or a transaction in it could not be read in time
 */

/**
 * Everything `resolveOg` knows about a name, before it makes an answer of it. The history is read only when a record needs it.
 * @param {Chain} chain the person's Ethereum node, read only
 * @param {string} label a label that passed `parseOgName` or `labelProblem`
 * @param {Lookup} lookup
 * @param {{ keys?: readonly string[], latest?: boolean }} [options] `keys`: the text keys to read, the answered ones by default; `latest`: pin to the latest block
 * @returns {Promise<Inspection>}
 */
export async function inspectOg (chain, label, lookup, options = {}) {
  const { session, census, signal, deadlineAt, progress } = lookup
  const keys = options.keys ?? TEXT_KEYS.map(([text]) => text)
  const key = keyOf(label)
  const pinned = await pinBlocks(chain, { latest: options.latest ?? session.written.has(label) })
  const block = Math.max(pinned.block, census.block)
  const { final } = pinned
  const call = newCall()
  signal?.throwIfAborted()
  progress?.('Reading the name')
  const reads = await readName(chain, key, block, keys)
  const holder = holderOf(key, reads)
  const base = { label, key, block, reads, holder }
  if (!holder.found || holder.holder === null) return { ...base, verdict: null, refusal: null }
  // With nothing to vouch for there is nothing to read: no text record (or a controller that is not the holder, which keeps every record out
  // whatever the logs say) and no value in the registry's slot (or a wrapped name's, which never counts).
  const empty = { setText: [], newController: [], registryChanged: [], wrapperTransfers: [] }
  const early = evaluateFreshness(key, reads, empty)
  const texts = !(keys.every((text) => (reads.values[text] ?? '') === '') || !early.controllerOk)
  const slot = !holder.wrapped && !holder.stranded && reads.registryContent !== null && reads.registryContent !== ZERO_SLOT
  if (!texts && !slot) return { ...base, verdict: early, refusal: null }
  try {
    // The resolver contract's upgrades matter to its text records only.
    const [tail] = await Promise.all([
      scanName(chain, lookup, { label, key, tokenId: holder.wrapped ? String(reads.nameToId) : null, block, final, call }),
      texts ? guardResolver(chain, session, { block, final, call, checkpoint: census.block, implementation: census.implementation, upgrades: census.upgrades, deadlineAt, signal, progress }) : undefined
    ])
    // A wrapped name's holder change is the wrapper's transfer, which no registry call tells.
    const read = holder.wrapped ? tail : await readCalls(chain, lookup, { label, key, tail, final, call })
    return { ...base, verdict: evaluateFreshness(key, reads, mergedLogs({ key, reads, entry: entryOf(census, label), checkpoint: census.block, tail: read })), refusal: null }
  } catch (error) {
    if (error instanceof OgRefusal) return { ...base, verdict: null, refusal: error }
    throw error
  }
}

/**
 * @param {Chain} chain the person's Ethereum node, read only
 * @param {unknown} name a host such as `alice.og`, or any text a site asks about
 * @param {Lookup} lookup
 * @param {{ web3?: boolean }} [options] `web3`: also read `contentcontract`, by the rule every content key is held to, and answer it as the
 *   `web3` record of a contract; the answer of a standard version that has no such record type never asks for it
 * @returns {Promise<Answer>} no owner default, and no records for a name that is not there, has none, or none that count. Throws a
 *   `ChainError` when the node cannot be asked, `OgRefusal` when the answer cannot be given safely or in time, and `invalid` for a name
 *   that is not under `.og`
 */
export async function resolveOg (chain, name, lookup, options = {}) {
  const label = parseOgName(name)
  if (label === null) return notFound()
  const web3 = options.web3 === true
  const found = await inspectOg(chain, label, lookup, web3 ? { keys: CENSUS_KEYS } : {})
  if (found.refusal !== null) throw found.refusal
  if (found.verdict === null) return notFound(found.block)
  const counted = found.verdict.records.map((name) => /** @type {const} */ ([name, name === REGISTRY_CONTENT ? found.reads.registryContent : found.reads.values[name]]))
  return answerOf(Object.fromEntries(counted), found.block, { web3 })
}

/**
 * Reads ahead of the first lookup: the resolver contract's upgrade scan, which every answer needs, and the recent history of each
 * census name, so a name that has a site is quick to open. No call waits for it: each window it reads is kept for the lookups that follow,
 * and it stops starting reads at `deadlineAt`.
 * @param {Chain} chain
 * @param {Pick<Lookup, 'session' | 'census' | 'deadlineAt'>} lookup
 * @param {(line: string) => void} [log] says why a part stopped, for the page's console
 * @returns {Promise<void>}
 */
export async function warmUp (chain, lookup, log = () => {}) {
  const { session, census, deadlineAt } = lookup
  const pinned = await pinBlocks(chain)
  const block = Math.max(pinned.block, census.block)
  // The read-ahead is no one's lookup: it takes the page's turns at the node only when no lookup wants them.
  const call = newCall({ background: true })
  const { final } = pinned
  const stopped = (/** @type {string} */ what, /** @type {unknown} */ error) => { log(`${what} stopped: ${error instanceof Error ? error.message : String(error)}`) }
  const upgrades = async () => {
    try {
      await scanLogs(chain, session, upgradedScan(census.block + 1, block), { deadlineAt, what: 'the resolver contract for upgrades', call, final })
    } catch (error) {
      stopped('the upgrade scan', error)
    }
  }
  const history = async (/** @type {string} */ label) => {
    try {
      const key = keyOf(label)
      const reads = await readName(chain, key, block)
      const { found, wrapped } = holderOf(key, reads)
      if (found) await scanName(chain, { session, census, deadlineAt }, { label, key, tokenId: wrapped ? String(reads.nameToId) : null, block, final, call })
    } catch (error) {
      stopped(`reading ${label}.og`, error)
    }
  }
  await Promise.all([upgrades(), ...Object.keys(census.names).slice(0, MAX_WARM_NAMES).map(history)])
}
