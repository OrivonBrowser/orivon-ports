// The guard on the resolver contract. The records live in an upgradeable proxy that a Safe of nine owners (five to act) can
// point at any code in one transaction, with no delay, so a record is only as good as the implementation behind it. This
// resolver answers from one implementation it was built against. The proxy must still point at it, the census must list exactly the
// upgrades the proxy had (`UPGRADES`), and no upgrade of the proxy may have been logged after the census checkpoint: pointing the
// proxy at other code and back leaves the slot as it was and an `Upgraded` log behind. Any check failing, or the scan that makes the
// last not finishing, refuses the answer.

import { sameAddress } from '../sdk/abi.js'
import { toHex } from '../sdk/bytes.js'
import { IMPLEMENTATION_SLOT, PROXY, TOPICS, UPGRADES } from './og-pins.js'
import { OgRefusal, scanLogs } from './og-tail.js'

/** @typedef {import('../sdk/chain.js').Chain} Chain */
/** @typedef {import('./og-tail.js').Session} Session */
/** @typedef {import('./og-tail.js').Call} Call */

/** The scan of every `Upgraded` log of the proxy: the same for every name, so a page makes it once. @param {number} from @param {number} to @returns {import('./og-tail.js').Scan} */
export const upgradedScan = (from, to) => ({
  id: 'upgraded',
  address: PROXY,
  topics: [TOPICS.upgraded],
  from,
  to,
  accept: (log) => sameAddress(log.address, PROXY) && log.topics[0]?.toLowerCase() === TOPICS.upgraded
})

/**
 * The address an ERC-1967 implementation slot holds: the last 20 bytes of its 32, whatever length the node trimmed the value to.
 * @param {Uint8Array} slot
 */
export const implementationIn = (slot) => `0x${toHex(slot).padStart(64, '0').slice(24)}`

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === 'object' && value !== null

/**
 * What differs between a list of the proxy's upgrades and the pinned one (`UPGRADES`), in words, or null when they are the same.
 * The census holds history up to its checkpoint as the bundle's word, and a round trip through other code before it would not show
 * in the slot or in the tail, so the list must be the one this resolver was built against, entry for entry.
 * @param {unknown} upgrades the `upgrades` of a census, or what the proxy's `Upgraded` logs gave
 * @returns {string | null}
 */
export function upgradesProblem (upgrades) {
  const found = Array.isArray(upgrades) ? upgrades : []
  const at = (/** @type {unknown} */ one, /** @type {{ block: number, logIndex: number }} */ pinned) => isObject(one) && one['block'] === pinned.block && one['logIndex'] === pinned.logIndex
  for (const pinned of UPGRADES) {
    const one = found.find((candidate) => at(candidate, pinned))
    if (one === undefined) return `the upgrade at block ${pinned.block} is missing`
    if (typeof one.implementation !== 'string' || !sameAddress(one.implementation, pinned.implementation)) return `the upgrade at block ${pinned.block} is not the one the pin lists`
  }
  const extra = found.find((candidate) => !UPGRADES.some((pinned) => at(candidate, pinned)))
  if (extra !== undefined) return isObject(extra) && typeof extra['block'] === 'number' ? `the proxy logged an upgrade at block ${extra['block']} that the pin does not list` : 'the list holds an entry that is not an upgrade'
  return found.length === UPGRADES.length ? null : 'the list holds an upgrade twice'
}

/**
 * Whether the proxy may be trusted at `block`. Resolves when it may; refuses in words when it may not or when that cannot be told.
 * @param {Chain} chain
 * @param {Session} session
 * @param {{ block: number, final: number, call: Call, checkpoint: number, implementation: string, upgrades: unknown, deadlineAt?: number | undefined, signal?: AbortSignal | undefined, progress?: ((detail: string, fraction?: number) => void) | undefined }} request
 *   `checkpoint`: the census block, the last block the bundle vouches for; `implementation`: the one the bundle was built against;
 *   `upgrades`: the upgrades the census lists up to the checkpoint; `final` and `call`: what `scanLogs` keeps windows up to, and who they are read for
 * @returns {Promise<void>}
 */
export async function guardResolver (chain, session, request) {
  const { block, final, call, checkpoint, implementation, upgrades: listed, deadlineAt, signal, progress } = request
  if (upgradesProblem(listed) !== null) {
    throw new OgRefusal('The upgrades of the contract that holds .og records, as this resolver\'s bundle lists them, are not the ones this resolver was built for, so its records are not vouched for. Update the .og resolver.')
  }
  const [slot, upgrades] = await Promise.all([
    chain.getStorageAt(PROXY, IMPLEMENTATION_SLOT, block),
    scanLogs(chain, session, upgradedScan(checkpoint + 1, block), { deadlineAt, signal, progress, what: 'the resolver contract for upgrades', call, final })
  ])
  if (!sameAddress(implementationIn(slot), implementation)) {
    throw new OgRefusal('The contract that holds .og records now runs code this resolver was not built for, so its records are not vouched for. Update the .og resolver.')
  }
  if (upgrades.length > 0) {
    throw new OgRefusal('The contract that holds .og records was upgraded after this resolver was built, so its records are not vouched for. Update the .og resolver.')
  }
}
