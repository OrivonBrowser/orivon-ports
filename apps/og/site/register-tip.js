// The optional "Support Orivon" tip: a plain transfer of ether, sent last. It goes to the address `orivonstack.eth` resolves to when
// the registration is built, read through the person's own node. No contract is involved, and nothing about the name depends on it.

import { decode, encodeCall, isAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { ChainError } from './sdk/chain.js'
import { dnsEncode, namehash } from './sdk/ens.js'
import { readContract } from './sdk/read.js'
import { formatEth } from './words.js'

/** ENS's Universal Resolver on mainnet: it finds a name's resolver in ENSv2 and in ENSv1 alike. */
export const UNIVERSAL_RESOLVER = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee'

export const TIP = Object.freeze({
  name: 'orivonstack.eth',
  defaultText: '0.0005',
  defaultWei: 500_000_000_000_000n,
  capWei: 5_000_000_000_000_000n,
  /** The most gas a tip to a contract is signed with, and what an estimate is multiplied by (percent) to get its limit. */
  contractGasCap: 100_000,
  contractGasMarginPercent: 125
})

/** @param {string} text decimal ether with up to 18 places, no sign and no exponent @returns {bigint | null} */
export function parseEther (text) {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text.trim())
  if (match === null) return null
  return BigInt(match[1] ?? '0') * 10n ** 18n + BigInt((match[2] ?? '').padEnd(18, '0'))
}

/**
 * The amount typed in the tip field.
 * @param {string} text
 * @returns {{ ok: true, wei: bigint } | { ok: false, words: string }}
 */
export function tipAmount (text) {
  const wei = parseEther(text)
  if (wei === null) return { ok: false, words: 'Write the tip in ether with digits and a dot, such as 0.0005, or untick it.' }
  if (wei === 0n) return { ok: false, words: 'A tip above 0 ETH, or untick it.' }
  if (wei > TIP.capWei) return { ok: false, words: `The tip is at most ${formatEth(TIP.capWei)}.` }
  return { ok: true, wei }
}

/**
 * The address a name points to, asked of ENS's Universal Resolver through the person's node. Any failure leaves the tip out; none
 * stops the registration.
 * @param {import('./sdk/chain.js').Chain} chain
 * @param {string} [name]
 * @returns {Promise<{ ok: true, address: string } | { ok: false, words: string }>}
 */
export async function resolveTipAddress (chain, name = TIP.name) {
  const left = `${name} could not be looked up right now, so no tip will be sent.`
  try {
    const inner = encodeCall('addr(bytes32)', [namehash(name)])
    const [result] = await readContract(chain, UNIVERSAL_RESOLVER, 'resolve(bytes,bytes)', [dnsEncode(name), inner], ['bytes', 'address'])
    const [address] = decode(['address'], /** @type {Uint8Array} */ (result))
    if (typeof address !== 'string' || !isAddress(address) || sameAddress(address, ZERO_ADDRESS)) return { ok: false, words: `${name} points to no address right now, so no tip will be sent.` }
    return { ok: true, address: toChecksumAddress(address) }
  } catch (error) {
    if (error instanceof ChainError && error.reason === 'declined') return { ok: false, words: `Orivon did not let this page look up ${name}, so no tip will be sent.` }
    return { ok: false, words: left }
  }
}

/**
 * What the tip line comes to.
 * @param {{ ticked: boolean, amountText: string, lookup: { ok: true, address: string } | { ok: false, words: string } | null }} parts `lookup` is null before the name has been looked up
 * @returns {{ tip: { to: string, wei: bigint, name: string } | null, blocks: boolean, words: string }} `blocks`: the amount is wrong and the person must fix it or untick
 */
export function tipPlanOf ({ ticked, amountText, lookup }) {
  if (!ticked) return { tip: null, blocks: false, words: '' }
  const amount = tipAmount(amountText)
  if (!amount.ok) return { tip: null, blocks: true, words: amount.words }
  if (lookup === null) return { tip: null, blocks: false, words: `Looking up ${TIP.name}…` }
  if (!lookup.ok) return { tip: null, blocks: false, words: lookup.words }
  return { tip: { to: lookup.address, wei: amount.wei, name: TIP.name }, blocks: false, words: '' }
}

/**
 * The gas a tip to `to` is signed with: none to name for an address with no code, whose transfer takes the 21,000 the plan gives it; for a
 * contract, what the node estimates for the transfer and a quarter more, at most 100,000. A contract that would not take it, or needs more
 * than that, is no place to send a tip: the receive function of a contract is code the person has not seen.
 * @param {import('./sdk/chain.js').Chain} chain
 * @param {{ to: string, wei: bigint, account: string | null }} tip
 * @returns {Promise<{ ok: true, gas?: number } | { ok: false, words: string }>}
 */
async function tipGas (chain, { to, wei, account }) {
  const left = (/** @type {string} */ why) => ({ ok: /** @type {const} */ (false), words: `${TIP.name} points to ${why}, so no tip will be sent.` })
  /** @type {Uint8Array} */
  let code
  try {
    code = await chain.getCode(to, 'latest')
  } catch {
    return left('an address that could not be looked up right now')
  }
  if (code.length === 0) return { ok: true }
  /** @type {number} */
  let estimate
  try {
    estimate = await chain.estimateGas({ ...(account === null ? {} : { from: account }), to, value: wei }, 'latest')
  } catch (error) {
    return error instanceof ChainError && error.reason === 'reverted'
      ? left('a contract that does not accept a plain transfer of ETH right now')
      : left('a contract whose cost for a transfer could not be looked up right now')
  }
  if (estimate > TIP.contractGasCap) return left(`a contract that needs more gas than a tip may use (${TIP.contractGasCap.toLocaleString('en-US')} at most)`)
  return { ok: true, gas: Math.min(TIP.contractGasCap, Math.ceil((estimate * TIP.contractGasMarginPercent) / 100)) }
}

/**
 * The tip as it will be sent, looked up when the person presses Register: the address now, set against the one they were shown, and what
 * is at that address (a contract is given the gas it needs, or the tip is left out).
 * @param {import('./sdk/chain.js').Chain} chain
 * @param {{ ticked: boolean, amountText: string, shown: string | null, account?: string | null }} parts `shown`: the address the review showed, null if it showed none
 * @returns {Promise<{ status: 'ok', tip: { to: string, wei: bigint, name: string, gas?: number } } | { status: 'none' | 'invalid' | 'changed', tip: null, words: string, address?: string }>}
 *   `none`: the tip is left out and the person is told why; `invalid`: the amount is wrong; `changed`: the name moved since the review
 */
export async function freezeTip (chain, { ticked, amountText, shown, account = null }) {
  if (!ticked) return { status: 'none', tip: null, words: '' }
  const amount = tipAmount(amountText)
  if (!amount.ok) return { status: 'invalid', tip: null, words: amount.words }
  const lookup = await resolveTipAddress(chain)
  if (!lookup.ok) return { status: 'none', tip: null, words: lookup.words }
  if (shown !== null && !sameAddress(shown, lookup.address)) {
    return { status: 'changed', tip: null, address: lookup.address, words: `${TIP.name} now points to ${lookup.address}, not the address the tip showed. Check the tip, then press Register again.` }
  }
  const gas = await tipGas(chain, { to: lookup.address, wei: amount.wei, account })
  if (!gas.ok) return { status: 'none', tip: null, words: gas.words }
  return { status: 'ok', tip: { to: lookup.address, wei: amount.wei, name: TIP.name, ...(gas.gas === undefined ? {} : { gas: gas.gas }) } }
}

/**
 * What became of the tip an earlier run of the same request sent, or may have sent, read from its receipt. A tip whose outcome cannot be
 * told is never sent again: a second one would be paid on top of a first that may have gone out.
 * @param {import('./sdk/chain.js').Chain} chain
 * @param {{ hash: string | null, maybeSent: boolean } | null} earlier the tip transaction the earlier run reached; null when it reached none
 * @returns {Promise<{ status: 'open' | 'paid' | 'unknown', words: string | null }>}
 *   `open`: no tip is on its way, so the tip is planned as asked; `paid` and `unknown`: it is left out, and `words` tells the person why
 */
export async function settleTip (chain, earlier) {
  if (earlier === null || !earlier.maybeSent) return { status: 'open', words: null }
  const unknown = {
    status: /** @type {const} */ ('unknown'),
    words: `It is not known whether your earlier tip went out${earlier.hash === null ? '' : ` (transaction ${earlier.hash})`}, so no tip is sent again. ` +
      'If it did not, send one from your wallet.'
  }
  if (earlier.hash === null) return unknown
  /** @type {import('./sdk/chain.js').Receipt | null} */
  let receipt
  try {
    receipt = await chain.getTransactionReceipt(earlier.hash)
  } catch {
    return unknown
  }
  if (receipt === null) return unknown
  return receipt.status === 1
    ? { status: 'paid', words: `Your tip was already sent (transaction ${earlier.hash}), so it is not sent again.` }
    : { status: 'open', words: 'Your earlier tip was mined and failed, so nothing reached the address. It is sent again.' }
}
