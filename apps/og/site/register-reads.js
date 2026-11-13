// What a registration reads from the chain: the name's state in the registry, the wrapper and the resolver (the same reads the
// resolver makes, so the two never disagree), and what only the wrapper knows: who it waits for, and whether wrapping is on.

import { decode, encodeCall } from './sdk/abi.js'
import { toHex } from './sdk/bytes.js'
import { ChainError } from './sdk/chain.js'
import { readContract, readTogether } from './sdk/read.js'
import { PROXY, REGISTRY, WRAPPER } from './resolver/og-pins.js'
import { keyOf } from './resolver/og-name.js'
import { readName } from './resolver/og-state.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {import('./register-plan.js').Facts} Facts */

/** The storage slot that packs the wrapper's three settings: `proxyMethodsAvail` in byte 0, `wrapEnabled` in byte 1 and the registry's address after them. */
export const SETTINGS_SLOT = `0x${'0'.repeat(62)}10`

/**
 * Whether the wrapper is accepting names. The flag has no getter, so it is read from storage; it is trusted only when the same slot
 * holds the registry's address where the wrapper's source keeps it.
 * @param {Chain} chain
 * @param {import('./sdk/chain.js').BlockRef} block
 * @returns {Promise<boolean | null>} null when the slot is not laid out as expected
 */
export async function readWrapEnabled (chain, block) {
  const slot = await chain.getStorageAt(WRAPPER, SETTINGS_SLOT, block)
  const value = BigInt(`0x${toHex(slot) || '0'}`)
  if (value >> 16n !== BigInt(REGISTRY)) return null
  const flag = (value >> 8n) & 0xffn
  return flag === 1n ? true : flag === 0n ? false : null
}

/**
 * The account's primary name and who the name resolves to, in one batch: what a change of primary reads and checks.
 * @param {Chain} chain
 * @param {string} key the name's registry key
 * @param {string} account
 * @param {import('./sdk/chain.js').BlockRef} block
 * @returns {Promise<{ primary: string | null, resolvesTo: string | null }>} null for a read that failed
 */
async function readPrimary (chain, key, account, block) {
  const [primaryData, resolvesData] = await readTogether(chain, [
    { to: PROXY, data: encodeCall('primary(address)', [account]) },
    { to: PROXY, data: encodeCall('resolveAddress(bytes32)', [key]) }
  ], block)
  const bytes = primaryData === null ? null : /** @type {Uint8Array | undefined} */ (decode(['bytes32'], primaryData)[0])
  const address = resolvesData === null ? null : decode(['address'], resolvesData)[0]
  return { primary: bytes === undefined || bytes === null ? null : `0x${toHex(bytes)}`, resolvesTo: typeof address === 'string' ? address : null }
}

/**
 * The state of a name at one block, with the wrapper's switch and who it waits for.
 * @param {Chain} chain
 * @param {string} label
 * @param {import('./sdk/chain.js').BlockRef} block a number, or a tag
 * @param {readonly string[]} [keys] the text keys to read
 * @param {string | null} [account] when given, the account's primary name and who the name resolves to are read too
 * @returns {Promise<Facts>}
 */
export async function readFacts (chain, label, block, keys = [], account = null) {
  const key = keyOf(label)
  const [reads, wait, wrapEnabled, named] = await Promise.all([
    readName(chain, key, /** @type {number} */ (block), keys),
    readContract(chain, WRAPPER, 'waitForWrap(bytes32)', [key], ['address'], block).then((answer) => /** @type {string | null} */ (answer[0] ?? null), (error) => {
      if (error instanceof ChainError && (error.reason === 'reverted' || error.reason === 'badAnswer')) return null
      throw error
    }),
    readWrapEnabled(chain, block),
    account === null ? Promise.resolve(null) : readPrimary(chain, key, account, block)
  ])
  return { key, ...reads, waitForWrap: wait, wrapEnabled, ...(named === null ? {} : named) }
}

/**
 * The same reads at a block a receipt names, tried again while the node is still catching up with it.
 * @param {Chain} chain
 * @param {string} label
 * @param {number} block
 * @param {readonly string[]} keys
 * @param {{ sleep: (ms: number) => Promise<void>, tries?: number, waitMs?: number }} clock
 * @param {string | null} [account] as for `readFacts`
 */
export async function readAfter (chain, label, block, keys, clock, account = null) {
  const { tries = 6, waitMs = 1500 } = clock
  for (let attempt = 1; ; attempt++) {
    try {
      return await readFacts(chain, label, block, keys, account)
    } catch (error) {
      const catchingUp = error instanceof ChainError && ['invalid', 'unavailable', 'badAnswer', 'reverted'].includes(error.reason)
      if (!catchingUp || attempt >= tries) throw error
      await clock.sleep(waitMs)
    }
  }
}
