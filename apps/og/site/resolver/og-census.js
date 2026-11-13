// The census: what a name's records and history looked like at the block the bundle was cut at (its checkpoint). Scanning a
// name's logs from 2015 costs tens of thousands of node calls, so the bundle carries the answer up to the checkpoint and
// the resolver scans only what came after. This file reads the census, turns an entry into the logs it stands for so the
// freshness rule runs over history and tail together, and cuts an entry from a name's whole history (the census tool).
// What the census says is the bundle's word, as the pinned implementation is; `tools/cut-census.mjs` rebuilds it from chain.

import { sameAddress } from '../sdk/abi.js'
import { addressTopic, evaluateFreshness, hashOf, holderOf, idTopic, latestWrite } from './og-freshness.js'
import { CENSUS_KEYS, TOPICS } from './og-pins.js'

/** @typedef {import('./og-pins.js').Position} Position */
/** @typedef {import('./og-freshness.js').NameLogs} NameLogs */
/** @typedef {import('./og-freshness.js').NameReads} NameReads */
/**
 * @typedef {object} KeyEntry one text key of a name at the checkpoint
 * @property {string} valueHash keccak-256 of the value stored then
 * @property {{ block: number, logIndex: number, valueHash: string } | null} log the latest log that wrote the key, with the hash of the value it carries
 * @property {boolean} counts whether the freshness rule kept the key at the checkpoint
 * @property {string} reason why
 */
/**
 * @typedef {object} NameEntry a name that had a content value at the checkpoint
 * @property {string} holder who held it then
 * @property {boolean} wrapped whether the holder held a wrapper token
 * @property {string | null} id the token, for a wrapped name
 * @property {{ block: number, logIndex: number } | null} holderChange the latest change of holder, as the rule reads it for that state
 * @property {{ block: number, logIndex: number } | null} newController the latest change of controller
 * @property {Record<string, KeyEntry>} keys
 */
/** @typedef {{ format: number, block: number, blockHash: string, implementation: string, upgrades: { block: number, logIndex: number, implementation: string }[], names: Record<string, NameEntry> }} Census */

export const CENSUS_FORMAT = 1

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The census a bundle carries, checked for shape: a malformed one is a broken bundle, and it fails every lookup that needs it
 * rather than guessing.
 * @param {unknown} raw the parsed census.json
 * @returns {Census}
 */
export function readCensus (raw) {
  if (!isObject(raw) || raw['format'] !== CENSUS_FORMAT) throw new Error('the census is not in a format this resolver reads')
  const { block, blockHash, implementation, upgrades, names } = raw
  if (!Number.isSafeInteger(block) || typeof blockHash !== 'string' || typeof implementation !== 'string' || !Array.isArray(upgrades) || !isObject(names)) throw new Error('the census lacks a block, an implementation or names')
  return /** @type {Census} */ (raw)
}

/**
 * @param {Census} census
 * @param {string} label
 * @returns {NameEntry | null} the name's entry, or null for a name that had no content value at the checkpoint
 */
export const entryOf = (census, label) => Object.hasOwn(census.names, label) ? /** @type {NameEntry} */ (census.names[label]) : null

const ZERO_TOPIC = `0x${'0'.repeat(64)}`

/**
 * The logs the freshness rule reads for a name now: the tail the node returned for (checkpoint, block], and what the census says
 * of everything before, as the logs it stands for. A census entry gives the holder at the checkpoint, so it stands for the change
 * of holder only while the holder is still that one; any other holder must show a change of its own in the tail. A name with no
 * entry had no content value at the checkpoint, so any record it has was written after it, and a change of holder or controller
 * before the checkpoint is before that record: a change before the checkpoint stands for the holder having been the holder then.
 * @param {{ key: string, reads: NameReads, entry: NameEntry | null, checkpoint: number, tail: NameLogs }} history
 * @returns {NameLogs}
 */
export function mergedLogs ({ key, reads, entry, checkpoint, tail }) {
  const logs = { setText: [...tail.setText], newController: [...tail.newController], registryChanged: [...tail.registryChanged], wrapperTransfers: [...tail.wrapperTransfers] }
  const { holder, wrapped } = holderOf(key, reads)
  if (holder === null) return logs
  const id = String(reads.nameToId)
  const sameHolder = entry === null || (sameAddress(entry.holder, holder) && entry.wrapped === wrapped && (!wrapped || entry.id === id))
  if (sameHolder) {
    const at = entry?.holderChange
    const place = at === undefined || at === null ? { blockNumber: checkpoint, logIndex: -1 } : { blockNumber: at.block, logIndex: at.logIndex }
    if (wrapped) logs.wrapperTransfers.push({ ...place, topics: [TOPICS.transfer, ZERO_TOPIC, addressTopic(holder), idTopic(id)] })
    else logs.registryChanged.push({ ...place, topics: [TOPICS.changed, key] })
  }
  if (entry === null) return logs
  if (entry.newController !== null) logs.newController.push({ blockNumber: entry.newController.block, logIndex: entry.newController.logIndex, topics: [TOPICS.newController, key, ZERO_TOPIC] })
  for (const [name, one] of Object.entries(entry.keys)) {
    if (one.log !== null) logs.setText.push({ blockNumber: one.log.block, logIndex: one.log.logIndex, topics: [TOPICS.setTextRecord, key, hashOf(name), one.log.valueHash] })
  }
  return logs
}

/**
 * A name's entry at a block, from its state then and every log it ever had.
 * @param {string} key the name's registry key
 * @param {NameReads} reads the state at the block, `values` holding every key of `CENSUS_KEYS`
 * @param {NameLogs} logs every log of the name up to the block
 * @returns {NameEntry | null} null for a name that is not there or had no content value
 */
export function censusEntryOf (key, reads, logs) {
  const verdict = evaluateFreshness(key, reads, logs)
  if (!verdict.found || verdict.holder === null) return null
  /** @type {Record<string, KeyEntry>} */
  const keys = {}
  for (const name of CENSUS_KEYS) {
    const value = reads.values[name]
    const one = verdict.keys[name]
    if (value === null || value === undefined || value === '' || one === undefined) continue
    const written = latestWrite(logs, name)
    keys[name] = {
      valueHash: hashOf(value),
      log: written === null ? null : { block: written.blockNumber, logIndex: written.logIndex, valueHash: written.topics[3] ?? '' },
      counts: one.counts,
      reason: one.reason
    }
  }
  if (Object.keys(keys).length === 0) return null
  return {
    holder: verdict.holder,
    wrapped: verdict.wrapped,
    id: verdict.wrapped ? String(reads.nameToId) : null,
    holderChange: verdict.holderChange ?? null,
    newController: verdict.controllerChange ?? null,
    keys
  }
}
