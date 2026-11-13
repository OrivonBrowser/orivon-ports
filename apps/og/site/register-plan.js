// The transactions a registration still has to make, from what the chain shows now. Pure. The order is fixed so that no step can
// strand a name and so that a record passes the freshness rule: the holder changes before the controller is named, and the
// records are written after both. The same function plans a first registration, one that stopped midway, and the finish of a name
// the wrapper holds, because each is only a different state of the chain.

import { sameAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { WRAPPER } from './resolver/og-pins.js'
import { createWrapperTx, reserveTx, setControllerTx, setTextTx, tipTx, transferTx, wrapTx } from './register-tx.js'
import { formatEth, shortAddress } from './words.js'

/** What each transaction is allowed: its measured use on a mainnet fork (tools/fork-series.mjs) and a margin; only the gas used is paid. */
export const GAS = Object.freeze({
  reserve: 70_000, setController: 90_000, createWrapper: 90_000, transfer: 60_000, wrap: 290_000, tip: 21_000,
  unwrap: 100_000, unsetController: 60_000, unsetRecord: 90_000, setPrimary: 130_000, unsetPrimary: 60_000, giveName: 60_000, sendToken: 200_000
})

/** @typedef {import('./register-tx.js').Call} Call */
/**
 * @typedef {object} Step
 * @property {string} id unique within a plan: the kind, and the text key of a record
 * @property {'reserve' | 'setController' | 'createWrapper' | 'transfer' | 'wrap' | 'record' | 'tip' | 'unwrap' | 'unsetController' | 'unsetRecord' | 'setPrimary' |
 *   'unsetPrimary' | 'giveName' | 'sendToken'} kind
 * @property {string} title
 * @property {string} contract which contract the call goes to, in words
 * @property {string} call the call, as a person can read it
 * @property {string} detail what the step is for
 * @property {Call} tx
 * @property {number} gas the gas limit it is signed with
 * @property {string} [textKey] a record's key
 * @property {string} [value] a record's value
 * @property {boolean} [rewrite] a record step that writes the value the record holds already, which costs far less than a first write
 * @property {string} [tokenId] the wrapper's token the step unwraps or sends, as a decimal number
 * @property {string} [to] who a step gives the name or its token to
 */
/**
 * What the chain says about the name and the wrapper, as `readFacts` reads it.
 * @typedef {object} Facts
 * @property {string} key
 * @property {string} registryOwner
 * @property {string | number | bigint} nameToId
 * @property {string | null} idToName
 * @property {string | null} ownerOf the holder of the name's token, null when it has none
 * @property {string | null} controller null when the read failed
 * @property {Record<string, string | null>} values
 * @property {string | null} waitForWrap
 * @property {boolean | null} wrapEnabled null when the wrapper's switch could not be read as expected
 * @property {string | null} [primary] the account's primary name as a registry key, the zero key for none; read only when asked for an account
 * @property {string | null} [resolvesTo] the address the resolver says the name belongs to, the zero address for none; read with `primary`
 */

/** A record's limit: 160,000 for a value of up to two storage words (62 characters used 130,692), and 25,000 for each word after. @param {string} value */
export const textGas = (value) => 160_000 + 25_000 * Math.max(0, Math.ceil(new TextEncoder().encode(value).length / 32) - 2)

export const REGISTRY_NAME = 'Linagee registry'
export const RESOLVER_NAME = 'Linagee resolver'
export const WRAPPER_NAME = 'Wrapper (ERC-721)'

/** @param {string | null} address @param {string} other */
const is = (address, other) => address !== null && sameAddress(address, other)

/**
 * Where a name stands for this account.
 * @param {Facts} facts
 * @param {string} account
 * @returns {'free' | 'mine' | 'wrappedMine' | 'stranded' | 'taken'} `mine`: the account holds it in the registry; `wrappedMine`: it holds the wrapper's token;
 *   `stranded`: the wrapper holds the name with no token and is waiting for this account to wrap it
 */
export function situationOf (facts, account) {
  const owner = facts.registryOwner
  if (sameAddress(owner, ZERO_ADDRESS)) return 'free'
  if (sameAddress(owner, account)) return 'mine'
  if (!sameAddress(owner, WRAPPER)) return 'taken'
  const issued = BigInt(facts.nameToId) !== 0n && facts.idToName?.toLowerCase() === facts.key.toLowerCase() && facts.ownerOf !== null
  if (issued) return is(facts.ownerOf, account) ? 'wrappedMine' : 'taken'
  return is(facts.waitForWrap, account) ? 'stranded' : 'taken'
}

/** @param {string} label @param {string} key @returns {Step} */
export const reserveStep = (label, key) => ({
  id: 'reserve', kind: 'reserve', title: 'Reserve the name', contract: REGISTRY_NAME, call: `reserve(${label})`, gas: GAS.reserve, tx: reserveTx(key),
  detail: 'Takes the name for your address. If someone took it first, nothing changes and nothing else is sent.'
})

/**
 * Names the account the controller of the name's records. `wrapping`: the name goes to the wrapper next, which owns it in the registry
 * afterwards, so only a controller named now can write its records later.
 * @param {string} label @param {string} key @param {string} account @param {boolean} wrapping @returns {Step}
 */
export const controllerStep = (label, key, account, wrapping) => ({
  id: 'setController', kind: 'setController', title: 'Make your address the controller of its records', contract: RESOLVER_NAME, call: `setController(${label}, you)`,
  gas: GAS.setController, tx: setControllerTx(key, account),
  detail: wrapping
    ? 'Needed while the name is wrapped: the wrapper owns it in the registry, so only a controller named now can write its records later.'
    : 'Removes the right of a previous holder to write the records of this name.'
})

/** @param {string} label @param {string} key @returns {Step} */
export const createWrapperStep = (label, key) => ({
  id: 'createWrapper', kind: 'createWrapper', title: 'Tell the wrapper to expect the name', contract: WRAPPER_NAME, call: `createWrapper(${label})`, gas: GAS.createWrapper,
  tx: createWrapperTx(key), detail: 'Marks your address as the one that will receive the token. If it fails, the name is not handed over.'
})

/** @param {string} label @param {string} key @returns {Step} */
export const handOverStep = (label, key) => ({
  id: 'transfer', kind: 'transfer', title: 'Hand the name to the wrapper', contract: REGISTRY_NAME, call: `transfer(${label}, wrapper)`, gas: GAS.transfer,
  tx: transferTx(key, WRAPPER), detail: 'Sent only after the step before it worked: without it the name would be stuck in the wrapper.'
})

/** @param {string} label @param {string} key @param {boolean} finishing the wrapper already holds the name @returns {Step} */
export const wrapStep = (label, key, finishing) => ({
  id: 'wrap', kind: 'wrap', title: finishing ? 'Finish wrapping the name' : 'Wrap the name', contract: WRAPPER_NAME, call: `wrap(${label})`, gas: GAS.wrap,
  tx: wrapTx(key), detail: 'The wrapper gives you a token (an NFT) for the name. Whoever holds the token holds the name, and can sell it.'
})

/**
 * One text record of the name.
 * @param {string} label @param {string} key @param {string} textKey @param {string} value
 * @param {{ title?: string, detail?: string, rewrite?: boolean }} [words] `rewrite`: the record holds this value already
 * @returns {Step}
 */
export const recordStep = (label, key, textKey, value, words = {}) => ({
  id: `record:${textKey}`, kind: 'record', title: words.title ?? 'Set the site', contract: RESOLVER_NAME, call: `setTextRecord(${label}, ${textKey}, …)`, gas: textGas(value),
  tx: setTextTx(key, textKey, value), textKey, value, detail: words.detail ?? `Points ${label}.og at ${value}. Written after the name is yours, so it counts.`,
  ...(words.rewrite === true ? { rewrite: true } : {})
})

/**
 * @param {object} want
 * @param {string} want.label
 * @param {string} want.account
 * @param {Facts} want.facts
 * @param {boolean} want.wrapped whether to end with the wrapper's token
 * @param {{ key: string, text: string } | null} want.site the record to write, if any
 * @param {{ to: string, wei: bigint, name: string, gas?: number } | null} want.tip `gas`: the limit it is signed with, when the address has code
 * @param {readonly string[]} [want.done] the ids of the steps an earlier run of this request finished and checked: a record among them is not
 *   written again while the chain holds its value. The same value on a name that changed hands may be a previous holder's, written before.
 * @param {boolean} [want.tipOwed] an earlier run stopped at the tip, so it is planned even when no other step is left
 * @returns {{ situation: ReturnType<typeof situationOf>, steps: Step[], notes: string[] }} no steps for a name that is taken
 */
export function planSeries ({ label, account, facts, wrapped, site, tip, done = [], tipOwed = false }) {
  const situation = situationOf(facts, account)
  /** @type {Step[]} */
  const steps = []
  /** @type {string[]} */
  const notes = []
  if (situation === 'taken') return { situation, steps, notes }
  const { key } = facts
  const self = facts.controller !== null && sameAddress(facts.controller, account)
  const none = facts.controller !== null && sameAddress(facts.controller, ZERO_ADDRESS)
  const wrapping = situation === 'stranded' || (wrapped && situation !== 'wrappedMine')
  if (situation === 'free') steps.push(reserveStep(label, key))
  if ((situation === 'free' || situation === 'mine') && (wrapping ? !self : !(self || none))) steps.push(controllerStep(label, key, account, wrapping))
  if (wrapping && situation !== 'stranded') steps.push(createWrapperStep(label, key), handOverStep(label, key))
  if (wrapping) steps.push(wrapStep(label, key, situation === 'stranded'))
  const writable = situation === 'free' || situation === 'mine' || self
  if (site !== null && writable) {
    const written = done.includes(`record:${site.key}`) && facts.values[site.key] === site.text
    if (!written) steps.push(recordStep(label, key, site.key, site.text))
  } else if (site !== null) {
    notes.push(
      'The site was not planned: this name\'s records can be written only by its controller, and that is not your address. ' +
      'Unwrap the name, make your address the controller, and wrap it again to set one.'
    )
  }
  if (tip !== null && (steps.length > 0 || tipOwed)) {
    steps.push({
      id: 'tip', kind: 'tip', title: 'Support Orivon', contract: 'A plain transfer of ETH', call: `${formatEth(tip.wei)} to ${tip.name} (${shortAddress(tip.to)})`, gas: tip.gas ?? GAS.tip,
      tx: tipTx(tip.to, tip.wei), detail: 'Optional, and sent last: only if every step above worked.'
    })
  }
  return { situation, steps, notes }
}

/** @param {readonly Step[]} steps */
export const totalGas = (steps) => steps.reduce((sum, step) => sum + step.gas, 0)

/** What each kind of step used on a mainnet fork (a record of 62 characters), for the cost shown before anything is signed. */
export const USED = Object.freeze({
  reserve: 45_149, setController: 58_506, createWrapper: 51_606, transfer: 28_489, wrap: 202_295, record: 130_692, tip: 21_000,
  unwrap: 69_513, unsetController: 36_264, unsetRecord: 50_324, setPrimary: 87_226, unsetPrimary: 34_556, giveName: 28_525, sendToken: 89_228,
  rewrite: 45_922
})

/** What the steps are expected to use, as against `totalGas`, which is the most they may. @param {readonly Step[]} steps */
export const expectedGas = (steps) => steps.reduce((sum, step) => sum + Math.min(step.gas, step.rewrite === true ? USED.rewrite : USED[step.kind]), 0)
