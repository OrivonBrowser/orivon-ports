// The freshness rule of a name's records, over the reads of one block and the logs of the name. A text record is
// the holder's only while no one else could have written it, and the resolver's `getTextRecord` cannot say who did, so
// the logs say it: a key counts when the controller is the holder (or there is none), and the latest log of that key
// carries the value now stored, after the latest change of holder and after the latest controller change. Pure: no
// network, no clock. The census tool and the resolver run this one function.

import { keccak256 } from '../sdk/keccak.js'
import { toHex, utf8 } from '../sdk/bytes.js'
import { sameAddress, ZERO_ADDRESS } from '../sdk/abi.js'
import { TOPICS, WRAPPER } from './og-pins.js'

/** @typedef {import('./og-pins.js').Position} Position */
/** @typedef {{ blockNumber: number, logIndex: number, topics: string[] }} LogLike */
/** @typedef {{ setText: LogLike[], newController: LogLike[], registryChanged: LogLike[], wrapperTransfers: LogLike[] }} NameLogs the logs of one name, each list of one event */
/**
 * @typedef {object} NameReads what the name's contracts say at one block
 * @property {string} registryOwner
 * @property {string | number | bigint} nameToId the wrapper's token for the name, 0 for none
 * @property {string | null} idToName the key the token stands for, or null when the read failed
 * @property {string | null} ownerOf the token's holder, or null when there is no such token
 * @property {string | null} controller the account that may also write the name's records, the zero address for none, null when the read failed
 * @property {Record<string, string | null>} values the text records, by key; null or empty for a key with no value
 */

/** @typedef {'passes' | 'controller-is-not-the-holder' | 'no-SetTextRecord-log' | 'latest-log-carries-another-value' | 'no-holder-change-log' | 'set-before-the-last-holder-change' | 'set-before-the-last-NewController'} Reason */
/** @typedef {{ counts: boolean, reason: Reason | 'empty', value?: string, writtenAt: Position | null }} KeyVerdict */

/** @param {string} text */
export const hashOf = (text) => `0x${toHex(keccak256(utf8(text)))}`

/** @param {string | bigint} id a token id, as a decimal string or a number */
export const idTopic = (id) => `0x${BigInt(id).toString(16).padStart(64, '0')}`

/** @param {string} address */
export const addressTopic = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`

/** A log's place as one number: block numbers stay under 2^27 and log indexes under a million, so it orders exactly in a double. @param {LogLike} log */
const place = (log) => log.blockNumber * 1e6 + log.logIndex

/** @param {LogLike[]} logs @returns {LogLike | null} the latest, or null for none */
const latest = (logs) => logs.reduce((best, log) => best === null || place(log) > place(best) ? log : best, /** @type {LogLike | null} */ (null))

/** @param {string} topic @param {string} wanted */
const is = (topic, wanted) => topic.toLowerCase() === wanted

/**
 * A name's logs by event.
 * @param {LogLike[]} found the registry's and the resolver's logs that carry the name
 * @param {LogLike[]} moved the wrapper's transfers of the name's token, none for a name that is not wrapped
 * @returns {NameLogs}
 */
export function nameLogsOf (found, moved) {
  const of = (/** @type {string} */ topic) => found.filter((log) => is(log.topics[0] ?? '', topic))
  return { setText: of(TOPICS.setTextRecord), newController: of(TOPICS.newController), registryChanged: of(TOPICS.changed), wrapperTransfers: moved }
}

/**
 * The latest log that wrote `name`'s text key, or null. Logs of an unset carry the hash of the empty key, so they never match one.
 * @param {NameLogs} logs
 * @param {string} name the text key
 * @returns {LogLike | null}
 */
export const latestWrite = (logs, name) => latest(logs.setText.filter((log) => is(log.topics[0] ?? '', TOPICS.setTextRecord) && is(log.topics[2] ?? '', hashOf(name))))

/**
 * Who holds the name: the registry owner, or for a name the wrapper holds, the holder of its token. A name the wrapper holds with no
 * token for it (or a token for another name) has no holder but the wrapper itself.
 * @param {string} key the name's registry key
 * @param {NameReads} reads
 * @returns {{ found: boolean, holder: string | null, wrapped: boolean, stranded: boolean }}
 */
export function holderOf (key, reads) {
  const owner = reads.registryOwner
  if (owner === '' || sameAddress(owner, ZERO_ADDRESS)) return { found: false, holder: null, wrapped: false, stranded: false }
  if (!sameAddress(owner, WRAPPER)) return { found: true, holder: owner, wrapped: false, stranded: false }
  const issued = BigInt(reads.nameToId) !== 0n && reads.idToName !== null && reads.idToName.toLowerCase() === key && reads.ownerOf !== null
  return issued ? { found: true, holder: /** @type {string} */ (reads.ownerOf), wrapped: true, stranded: false } : { found: true, holder: owner, wrapped: false, stranded: true }
}

/**
 * Which keys of `reads.values` count, and why each does or does not.
 * @param {string} key the name's registry key
 * @param {NameReads} reads
 * @param {NameLogs} logs
 * @returns {{ found: boolean, wrapped: boolean, stranded: boolean, holder: string | null, controllerOk: boolean, keys: Record<string, KeyVerdict>, records: string[], holderChange?: Position | null, controllerChange?: Position | null }}
 *   the latest change of holder and of controller the verdict was made against, for a name that is there
 */
export function evaluateFreshness (key, reads, logs) {
  const { found, holder, wrapped, stranded } = holderOf(key, reads)
  /** @type {Record<string, KeyVerdict>} */
  const keys = {}
  /** @type {string[]} */
  const records = []
  if (holder === null) return { found, wrapped, stranded, holder, controllerOk: false, keys, records }
  const controllerOk = reads.controller !== null && (sameAddress(reads.controller, ZERO_ADDRESS) || sameAddress(reads.controller, holder))
  const changes = wrapped
    ? logs.wrapperTransfers.filter((log) => is(log.topics[0] ?? '', TOPICS.transfer) && is(log.topics[2] ?? '', addressTopic(holder)))
    : logs.registryChanged.filter((log) => is(log.topics[0] ?? '', TOPICS.changed))
  const holderChange = latest(changes)
  const controllerChange = latest(logs.newController.filter((log) => is(log.topics[0] ?? '', TOPICS.newController)))
  for (const [name, value] of Object.entries(reads.values)) {
    if (value === null || value === '') {
      keys[name] = { counts: false, reason: 'empty', writtenAt: null }
      continue
    }
    const written = latestWrite(logs, name)
    /** @type {Reason} */
    let reason = 'passes'
    if (!controllerOk) reason = 'controller-is-not-the-holder'
    else if (written === null) reason = 'no-SetTextRecord-log'
    else if (!is(written.topics[3] ?? '', hashOf(value))) reason = 'latest-log-carries-another-value'
    else if (holderChange === null) reason = 'no-holder-change-log'
    else if (place(written) <= place(holderChange)) reason = 'set-before-the-last-holder-change'
    else if (controllerChange !== null && place(written) <= place(controllerChange)) reason = 'set-before-the-last-NewController'
    keys[name] = { counts: reason === 'passes', reason, value, writtenAt: written === null ? null : { block: written.blockNumber, logIndex: written.logIndex } }
    if (reason === 'passes') records.push(name)
  }
  return { found, wrapped, stranded, holder, controllerOk, keys, records, holderChange: holderChange === null ? null : { block: holderChange.blockNumber, logIndex: holderChange.logIndex }, controllerChange: controllerChange === null ? null : { block: controllerChange.blockNumber, logIndex: controllerChange.logIndex } }
}
