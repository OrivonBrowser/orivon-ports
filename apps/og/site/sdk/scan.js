// Reading R1's logs for the labels an address was registered or sent. The logs only find candidates: the registry is
// asked about each one before a page lists it (namesOf in orivonid.js).

import { decodeLog, parseEvent, sameAddress } from './abi.js'
import { toHex } from './bytes.js'
import { ChainError, MAX_LOG_SPAN } from './chain.js'
import { labelhash } from './ens.js'

/** @typedef {import('./chain.js').Chain} Chain */

export const LABEL_REGISTERED = parseEvent(
  'LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)'
)
export const TRANSFER_SINGLE = parseEvent('TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)')
export const TRANSFER_BATCH = parseEvent('TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)')

/**
 * How far back from its head Orivon's light client is asked for logs, in whole ranges of MAX_LOG_SPAN blocks. It proves
 * logs only for recent blocks, and a node that is not an archive refuses older ones: the ranges up to this far back
 * answered every time they were asked, ones further back failed now and then, and from about 12,000 blocks back
 * nearly always. A scan from R1's first block would be refused on its first range.
 */
export const SCAN_WINDOW = 3 * MAX_LOG_SPAN

/** Unresolved token ids a cache keeps, newest last. */
const MAX_UNNAMED = 32

/**
 * @typedef {object} NamesCache What a scan found, for the caller to keep and hand back. Plain JSON.
 * @property {1} version
 * @property {string} address the lower-cased address it belongs to
 * @property {number} [firstBlock] the oldest block the scan has read without a gap up to `lastBlock`; absent means the registry's first
 * @property {number} lastBlock the newest block it has looked at, less the margin for replaced blocks
 * @property {Record<string, string>} labels every label registered on R1 that the scan saw, by the token id's shared bits
 * @property {string[]} held labels this address was ever given
 * @property {string[]} [unnamed] token ids (shared bits) sent to this address whose label the scan could not name
 */

/** A token id with its version bits cleared: the part of a label's hash every version of its token shares. @param {bigint} id */
export const tokenKey = (id) => (id >> 32n).toString(16).padStart(56, '0')

/** @param {string} address @param {number} first @returns {NamesCache} */
const freshCache = (address, first) => ({ version: 1, address: address.toLowerCase(), firstBlock: first, lastBlock: first - 1, labels: {}, held: [] })

/** @param {string} address @returns {string} the address as a 32-byte log topic */
const addressTopic = (address) => '0x' + address.slice(2).toLowerCase().padStart(64, '0')

/**
 * @typedef {object} Where
 * @property {string} registry R1's address
 * @property {number} first the block R1 was created in
 * @property {number} margin blocks the next scan repeats, in case the newest were replaced
 * @property {boolean} windowed read only the last SCAN_WINDOW blocks: the chain is a light client, which proves no older logs
 * @property {readonly string[]} named labels known from elsewhere, so a token sent to the address can be named without its registration
 */

/**
 * Reads R1's logs from where `cache` left off, or from SCAN_WINDOW blocks behind `head` when that is nearer, in ranges the
 * node accepts, and notes every label `address` was registered or sent. A range that cannot be read is tried once more; if it
 * still cannot, the scan goes on to the newer ones when it is windowed and stops when it is not, and the cache does not move
 * its newest block, so the next scan reads the same blocks again.
 * @param {Chain} chain
 * @param {string} address
 * @param {NamesCache | null | undefined} cache
 * @param {number} head
 * @param {Where} where
 * @returns {Promise<{ cache: NamesCache, failed: boolean }>}
 */
export async function scanLogs (chain, address, cache, head, where) {
  const { registry, first, margin, windowed } = where
  const usable = cache?.version === 1 && sameAddress(cache.address, address)
  const state = usable ? structuredClone(/** @type {NamesCache} */ (cache)) : freshCache(address, first)
  if (!Number.isSafeInteger(state.firstBlock)) state.firstBlock = first
  const floor = windowed ? Math.max(first, head - SCAN_WINDOW + 1) : first
  const joined = state.lastBlock + 1 >= floor && state.firstBlock <= floor
  const begin = joined ? state.lastBlock + 1 : floor
  const held = new Set(state.held)
  const unnamed = new Set(state.unnamed ?? [])
  const named = new Map(where.named.map((label) => [tokenKey(BigInt(labelhash(label))), label]))
  const topic = addressTopic(address)
  const nameOfKey = (/** @type {string} */ key) => state.labels[key] ?? named.get(key)
  let failed = false

  for (let from = begin; from <= head; from += MAX_LOG_SPAN) {
    const range = { fromBlock: from, toBlock: Math.min(from + MAX_LOG_SPAN - 1, head), address: registry }
    const logs = await readRange(chain, range, topic)
    if (logs === null) {
      failed = true
      if (windowed) continue
      break
    }
    for (const log of logs.registered) {
      const fields = decodeLog(LABEL_REGISTERED, log)
      const label = /** @type {string} */ (fields['label'])
      if (labelhash(label) !== '0x' + toHex(/** @type {Uint8Array} */ (fields['labelHash']))) continue
      state.labels[tokenKey(/** @type {bigint} */ (fields['tokenId']))] = label
      if (sameAddress(/** @type {string} */ (fields['owner']), address)) held.add(label)
    }
    const received = [
      ...logs.singles.map((log) => [decodeLog(TRANSFER_SINGLE, log)['id']]),
      ...logs.batches.map((log) => /** @type {bigint[]} */ (decodeLog(TRANSFER_BATCH, log)['ids']))
    ].flat()
    for (const id of received) {
      const key = tokenKey(/** @type {bigint} */ (id))
      const label = nameOfKey(key)
      if (label === undefined) unnamed.add(key)
      else held.add(label)
    }
  }
  for (const key of unnamed) {
    const label = nameOfKey(key)
    if (label === undefined) continue
    held.add(label)
    unnamed.delete(key)
  }
  state.held = [...held].sort()
  state.unnamed = [...unnamed].slice(-MAX_UNNAMED)
  if (!failed) {
    state.lastBlock = Math.max(state.lastBlock, head - margin)
    if (!joined) state.firstBlock = floor
  }
  return { cache: state, failed }
}

/**
 * One range's three kinds of log, or null when it could not be read twice running.
 * @param {Chain} chain
 * @param {{ fromBlock: number, toBlock: number, address: string }} range
 * @param {string} topic
 */
async function readRange (chain, range, topic) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const [registered, singles, batches] = await Promise.all([
        chain.getLogs({ ...range, topics: [LABEL_REGISTERED.topic] }),
        chain.getLogs({ ...range, topics: [TRANSFER_SINGLE.topic, null, null, topic] }),
        chain.getLogs({ ...range, topics: [TRANSFER_BATCH.topic, null, null, topic] })
      ])
      return { registered, singles, batches }
    } catch (error) {
      if (!(error instanceof ChainError)) throw error
    }
  }
  return null
}
