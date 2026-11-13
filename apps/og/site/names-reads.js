// What the list of a person's names reads from the chain: the wrapper's tokens the account holds (ERC-721 Enumerable), the names the
// resolver and the registry hint at for the address, and the check of a name added by hand. No indexer and no server: every read is the
// person's own node's, pinned to one block so the three steps of the token list agree.

import { decode, encodeCall } from './sdk/abi.js'
import { toHex } from './sdk/bytes.js'
import { ChainError } from './sdk/chain.js'
import { readTogether } from './sdk/read.js'
import { PROXY, REGISTRY, WRAPPER } from './resolver/og-pins.js'
import { classifyAdded, labelOfKey, ZERO_KEY } from './names-model.js'
import { readFacts } from './register-reads.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */

/** The most tokens read for one account at once. A person who holds more is told how many were left out. */
export const TOKEN_LIMIT = 120

/** @param {number} count @returns {number[]} */
const range = (count) => Array.from({ length: count }, (_, index) => index)

/**
 * The wrapped names an account holds.
 * @param {Chain} chain
 * @param {string} account
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{ block: number, total: number, tokens: { label: string, tokenId: string }[], unreadable: number, left: number }>}
 *   `unreadable`: tokens whose name is not text this page can show; `left`: tokens not read because of `limit`
 */
export async function readWrappedTokens (chain, account, options = {}) {
  const block = await chain.blockNumber()
  const [balance] = await readTogether(chain, [{ to: WRAPPER, data: encodeCall('balanceOf(address)', [account]) }], block)
  if (balance === null) throw new ChainError('badAnswer', 'the wrapper did not answer balanceOf')
  const total = Number(/** @type {bigint} */ (decode(['uint256'], balance)[0]))
  const count = Math.min(total, options.limit ?? TOKEN_LIMIT)
  if (count === 0) return { block, total, tokens: [], unreadable: 0, left: 0 }
  const ids = await readTogether(chain, range(count).map((index) => ({ to: WRAPPER, data: encodeCall('tokenOfOwnerByIndex(address,uint256)', [account, BigInt(index)]) })), block)
  const known = ids.flatMap((data) => data === null ? [] : [/** @type {bigint} */ (decode(['uint256'], data)[0])])
  const names = await readTogether(chain, known.map((id) => ({ to: WRAPPER, data: encodeCall('idToName(uint256)', [id]) })), block)
  /** @type {{ label: string, tokenId: string }[]} */
  const tokens = []
  let unreadable = ids.length - known.length
  known.forEach((id, index) => {
    const data = names[index]
    const label = data === null || data === undefined ? null : labelOfKey(`0x${toHex(/** @type {Uint8Array} */ (decode(['bytes32'], data)[0]))}`)
    if (label === null) unreadable++
    else tokens.push({ label, tokenId: String(id) })
  })
  return { block, total, tokens, unreadable, left: total - count }
}

/**
 * The names the contracts name for an address: its primary name on the resolver, and the name the registry lists for it. Each is only a
 * hint; the page checks that the account holds it before it is shown as one of the account's names.
 * @param {Chain} chain
 * @param {string} account
 * @returns {Promise<string[]>}
 */
export async function readHints (chain, account) {
  const block = await chain.blockNumber()
  const answers = await readTogether(chain, [
    { to: PROXY, data: encodeCall('primary(address)', [account]) },
    { to: REGISTRY, data: encodeCall('name(address)', [account]) }
  ], block)
  /** @type {string[]} */
  const labels = []
  for (const data of answers) {
    if (data === null) continue
    const key = `0x${toHex(/** @type {Uint8Array} */ (decode(['bytes32'], data)[0]))}`
    if (key === ZERO_KEY) continue
    const label = labelOfKey(key)
    if (label !== null && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/**
 * What the chain says about a name the person typed to add, for the account.
 * @param {Chain} chain
 * @param {string} label
 * @param {string} account
 */
export async function checkAdded (chain, label, account) {
  const facts = await readFacts(chain, label, 'latest', [], account)
  return { facts, ...classifyAdded(label, facts, account) }
}
