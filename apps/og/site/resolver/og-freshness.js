// The freshness rule of a name's records, over the reads of one block and the logs of the name. A text record is
// the holder's only while no one else could have written it, and the resolver's `getTextRecord` cannot say who did, so
// the logs say it: a key counts when the controller is the holder (or there is none), and the latest log of that key
// carries the value now stored, after the latest change of holder and after the latest controller change. The registry's own
// `content` slot is held to the same rule, with the log of its own write: only the owner can write it, but a transfer leaves it
// to the next owner, so it counts when a direct `setContent` of the value now stored came after the latest change of holder. Pure: no
// network, no clock. The census tool and the resolver run this one function.

import { keccak256 } from '../sdk/keccak.js'
import { toHex, utf8 } from '../sdk/bytes.js'
import { sameAddress, ZERO_ADDRESS } from '../sdk/abi.js'
import { REGISTRY_CONTENT, TOPICS, WRAPPER } from './og-pins.js'
import { SETTERS } from './og-registry-calls.js'

/** @param {string} text */
export const hashOf = (text) => `0x${toHex(keccak256(utf8(text)))}`

/** @typedef {import('./og-pins.js').Position} Position */
/** @typedef {import('./og-registry-calls.js').RegistryCall} RegistryCall */
/**
 * @typedef {object} LogLike
 * @property {number} blockNumber
 * @property {number} logIndex
 * @property {string[]} topics
 * @property {string} [transactionHash]
 * @property {RegistryCall | null} [call] for a registry `Changed` log whose transaction was read: the direct call it made about the name, or null for any
 *   other (a call through a contract, an unknown selector, input that does not decode). A log with no `call` was not read, as the census's stand-in for a
 *   change of holder is not, and an unread call is a change of holder.
 */
/** @typedef {{ setText: LogLike[], newController: LogLike[], registryChanged: LogLike[], wrapperTransfers: LogLike[] }} NameLogs the logs of one name, each list of one event */
/**
 * @typedef {object} NameReads what the name's contracts say at one block
 * @property {string} registryOwner
 * @property {string | number | bigint} nameToId the wrapper's token for the name, 0 for none
 * @property {string | null} idToName the key the token stands for, or null when the read failed
 * @property {string | null} ownerOf the token's holder, or null when there is no such token
 * @property {string | null} controller the account that may also write the name's records, the zero address for none, null when the read failed
 * @property {string | null} registryContent the registry's own `content` slot: 0x and 64 hexadecimal digits, all zeros for none, null when the read failed
 * @property {Record<string, string | null>} values the text records, by key; null or empty for a key with no value
 */

/** @typedef {'passes' | 'controller-is-not-the-holder' | 'no-SetTextRecord-log' | 'latest-log-carries-another-value' | 'no-holder-change-log' | 'set-before-the-last-holder-change' | 'set-before-the-last-NewController'} Reason */
/** @typedef {'registry-content-no-holder' | 'registry-content-on-a-wrapped-name' | 'registry-content-no-setContent-log' | 'registry-content-set-before-the-last-holder-change'} RegistryReason why the registry's slot does not count, besides `no-holder-change-log` */
/** @typedef {{ counts: boolean, reason: Reason | RegistryReason | 'empty', value?: string, writtenAt: Position | null }} KeyVerdict */

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

/** @param {LogLike} log whether a registry `Changed` log is the name changing hands: any but a direct call of a setter the owner made, so a call that was not read is one */
const changesHolder = (log) => is(log.topics[0] ?? '', TOPICS.changed) && !(log.call !== undefined && log.call !== null && SETTERS.has(log.call.fn))

const ZERO_SLOT = `0x${'0'.repeat(64)}`

/**
 * Whether the registry's `content` slot counts. Only the owner writes it, but a transfer leaves the value to the next owner and nothing in
 * the slot says who wrote it, so it counts only when the name is unwrapped and a direct `setContent` of the value now stored, as the log of
 * the registry says, came after the latest change of holder. A write made through a contract has no such log and does not count.
 * @param {NameReads} reads
 * @param {{ holder: string | null, wrapped: boolean, stranded: boolean }} held
 * @param {NameLogs} logs
 * @param {LogLike | null} holderChange the latest change of holder, for an unwrapped name
 * @returns {KeyVerdict}
 */
function registryVerdict (reads, held, logs, holderChange) {
  const value = reads.registryContent?.toLowerCase() ?? null
  if (value === null || value === ZERO_SLOT) return { counts: false, reason: 'empty', writtenAt: null }
  const at = (/** @type {LogLike | null} */ log) => log === null ? null : { block: log.blockNumber, logIndex: log.logIndex }
  if (held.holder === null) return { counts: false, reason: 'registry-content-no-holder', value, writtenAt: null }
  if (held.wrapped || held.stranded) return { counts: false, reason: 'registry-content-on-a-wrapped-name', value, writtenAt: null }
  const written = latest(logs.registryChanged.filter((log) => is(log.topics[0] ?? '', TOPICS.changed) && log.call?.fn === 'setContent' && log.call.value.toLowerCase() === value))
  /** @type {KeyVerdict['reason']} */
  let reason = 'passes'
  if (written === null) reason = 'registry-content-no-setContent-log'
  else if (holderChange === null) reason = 'no-holder-change-log'
  else if (place(written) <= place(holderChange)) reason = 'registry-content-set-before-the-last-holder-change'
  return { counts: reason === 'passes', reason, value, writtenAt: at(written) }
}

/**
 * Which keys of `reads.values` count, and why each does or does not, and whether the registry's own `content` slot does.
 * @param {string} key the name's registry key
 * @param {NameReads} reads
 * @param {NameLogs} logs
 * @returns {{ found: boolean, wrapped: boolean, stranded: boolean, holder: string | null, controllerOk: boolean, keys: Record<string, KeyVerdict>, registry: KeyVerdict, records: string[], holderChange?: Position | null, controllerChange?: Position | null }}
 *   `records` lists the text keys that count, then `REGISTRY_CONTENT` when the slot does; the latest change of holder and of controller the
 *   verdict was made against, for a name that is there
 */
export function evaluateFreshness (key, reads, logs) {
  const held = holderOf(key, reads)
  const { found, holder, wrapped, stranded } = held
  /** @type {Record<string, KeyVerdict>} */
  const keys = {}
  /** @type {string[]} */
  const records = []
  if (holder === null) return { found, wrapped, stranded, holder, controllerOk: false, keys, registry: registryVerdict(reads, held, logs, null), records }
  const controllerOk = reads.controller !== null && (sameAddress(reads.controller, ZERO_ADDRESS) || sameAddress(reads.controller, holder))
  const changes = wrapped
    ? logs.wrapperTransfers.filter((log) => is(log.topics[0] ?? '', TOPICS.transfer) && is(log.topics[2] ?? '', addressTopic(holder)))
    : logs.registryChanged.filter(changesHolder)
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
  const registry = registryVerdict(reads, held, logs, wrapped ? null : holderChange)
  if (registry.counts) records.push(REGISTRY_CONTENT)
  return {
    found, wrapped, stranded, holder, controllerOk, keys, registry, records,
    holderChange: holderChange === null ? null : { block: holderChange.blockNumber, logIndex: holderChange.logIndex },
    controllerChange: controllerChange === null ? null : { block: controllerChange.blockNumber, logIndex: controllerChange.logIndex }
  }
}
