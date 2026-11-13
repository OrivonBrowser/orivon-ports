// What the registration panel decides from what the person typed and what the chain shows: the site record, the plan for each way
// of registering, and what it costs. Pure.

import { TEXT_KEYS } from './resolver/og-pins.js'
import { contenthashRecord } from './resolver/og-set-record.js'
import { textAddress } from './resolver/og-answer.js'
import { expectedGas, planSeries, totalGas } from './register-plan.js'
import { formatEth } from './words.js'

/** @typedef {import('./register-plan.js').Facts} Facts */
/** @typedef {import('./register-plan.js').Step} Step */

const BARE_CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,200})$/
const BARE_SWARM = /^[0-9a-fA-F]{64}$/
const ARWEAVE = /^ar:\/\/([A-Za-z0-9_-]{43})$/

export const SITE_WORDS = 'An ipfs://, ipns://, bzz:// or ar:// address. Leave it empty to set no site now.'

/**
 * The record a pasted site address is written as, in the key the resolver reads it from, or why it cannot be.
 * @param {string} input
 * @returns {{ kind: 'none' } | { kind: 'site', key: string, text: string, label: string } | { kind: 'problem', words: string }}
 */
export function siteRecordOf (input) {
  const typed = input.trim()
  if (typed === '') return { kind: 'none' }
  const wanted = BARE_CID.test(typed) ? `ipfs://${typed}` : BARE_SWARM.test(typed) ? `bzz://${typed}` : typed
  const arweave = ARWEAVE.exec(wanted)
  const found = arweave === null ? contenthashRecord(wanted) : { key: 'content.arw', text: wanted }
  const type = found === null ? undefined : TEXT_KEYS.find(([key]) => key === found.key)?.[1]
  if (found === null || type === undefined || textAddress(type, found.text) === null) {
    return { kind: 'problem', words: `Not an address Orivon can open. ${SITE_WORDS}` }
  }
  const label = found.key === 'content.bzz' ? 'Swarm' : found.key === 'content.arw' ? 'Arweave' : found.text.startsWith('ipns') ? 'IPNS' : 'IPFS'
  return { kind: 'site', key: found.key, text: found.text, label }
}

/**
 * What the panel under the search is for, by what the name offers. A name the account holds is not registered again: the panel wraps it,
 * and asks for no tip unless it is ticked.
 * @param {import('./search-model.js').Offer | undefined} offer
 * @returns {{ heading: string, button: string, wraps: boolean, tipTicked: boolean }} `wraps`: the panel has one job, wrapping, so it offers no choice of how to hold the name
 */
export function panelOf (offer) {
  if (offer === 'continue') return { heading: 'Wrap', button: 'Wrap it', wraps: true, tipTicked: false }
  if (offer === 'finish') return { heading: 'Finish wrapping', button: 'Finish wrapping', wraps: true, tipTicked: false }
  return { heading: 'Register', button: 'Register', wraps: false, tipTicked: true }
}

/**
 * Both ways of registering planned from the same facts, so the panel can show each with its gas.
 * @param {object} want
 * @param {string} want.label
 * @param {string} want.account
 * @param {Facts} want.facts
 * @param {{ key: string, text: string } | null} want.site
 * @param {{ to: string, wei: bigint, name: string, gas?: number } | null} want.tip
 */
export function optionsOf ({ label, account, facts, site, tip }) {
  const plan = (/** @type {boolean} */ wrapped) => {
    const planned = planSeries({ label, account, facts, wrapped, site, tip })
    return { ...planned, limit: totalGas(planned.steps), expected: expectedGas(planned.steps) }
  }
  return { wrapped: plan(true), unwrapped: plan(false), canWrap: facts.wrapEnabled === true }
}

/**
 * What a plan costs at the fee the node suggests now.
 * @param {{ steps: readonly Step[], expected: number, limit: number }} plan
 * @param {bigint | null} priceWei the fee per gas, or null when it could not be read
 * @returns {{ gas: string, ether: string | null, tipWei: bigint }} `ether` is the name's steps, without the tip
 */
export function costOf (plan, priceWei) {
  const tip = plan.steps.find((step) => step.kind === 'tip')
  const without = plan.steps.filter((step) => step.kind !== 'tip')
  const expected = expectedGas(without)
  return {
    gas: `about ${expected.toLocaleString('en-US')} gas, at most ${totalGas(without).toLocaleString('en-US')}`,
    ether: priceWei === null ? null : formatEth(BigInt(expected) * priceWei),
    tipWei: tip?.tx.value ?? 0n
  }
}
