// Moving an ID to a resolver its holder controls: the words, the three steps, and where a move stands as a pure function of
// what the chain shows. Nothing is remembered between calls, so a page that reloads halfway plans again from the chain and
// continues from the first step that is not done. Pure.

import { sameAddress } from './sdk/abi.js'
import { toHex } from './sdk/bytes.js'
import { nameOf } from './sdk/orivonid.js'
import { NOT_BEFORE_KEY } from './sdk/protocol.js'
import { COMMON_KEYS } from './me-model.js'
import { deployResolverTx, recordsTx, setResolverTx } from './register-tx.js'
import { STEP_WORDS } from './register-model.js'

/** @typedef {import('./sdk/orivonid.js').RecordsRead} RecordsRead */
/** @typedef {'deploy' | 'records' | 'resolver'} MoveStep */
/** @typedef {{ to: string, data: Uint8Array }} Call */

export const MOVE_ORDER = /** @type {readonly MoveStep[]} */ (['deploy', 'records', 'resolver'])

/** What each transaction of a move is for, in the words beside it. */
export const MOVE_STEPS = Object.freeze({
  deploy: STEP_WORDS.deploy,
  records: { title: 'Set the records on it', detail: 'Points the ID at your address on your resolver, and copies the records you chose.' },
  resolver: { title: 'Point the ID at it', detail: 'Changes the resolver the registry names for the ID. This is the step that ends its sign-ins.' }
})

/** The text records worth carrying over: the ones My IDs lists and any key the person added, never the record that ends sign-ins. @param {readonly string[]} [extra] */
export const copyKeys = (extra = []) => [...new Set([...COMMON_KEYS, ...extra])].filter((key) => key !== NOT_BEFORE_KEY)

/**
 * What a copy would carry from the records the name has now.
 * @typedef {object} Copying
 * @property {boolean} readable false when the old resolver answered no question about its records
 * @property {Uint8Array | null} contenthash
 * @property {Record<string, string>} texts
 * @property {number} count records to carry
 * @property {string[]} skipped records the old resolver would not answer
 */

/** @type {Copying} */
const NOTHING = Object.freeze({ readable: true, contenthash: null, texts: Object.freeze({}), count: 0, skipped: Object.freeze([]) })

/** @param {RecordsRead | null} old the records of the resolver the name has now @returns {Copying} */
export function copySet (old) {
  if (old === null || old.resolver === null) return NOTHING
  const texts = Object.fromEntries(Object.entries(old.texts).filter(([key, value]) => value !== null && key !== NOT_BEFORE_KEY))
  const asked = 1 + Object.keys(old.texts).length
  const failed = old.failed.filter((name) => name !== 'addr')
  return /** @type {Copying} */ ({
    readable: failed.length < asked, contenthash: old.contenthash, texts, count: (old.contenthash === null ? 0 : 1) + Object.keys(texts).length,
    skipped: failed.map((name) => name.replace(/^text:/, ''))
  })
}

/** What the checkbox says, and whether it can be ticked. @param {Copying} copying @returns {{ available: boolean, detail: string }} */
export function copyWords (copying) {
  if (!copying.readable) return { available: false, detail: 'The current resolver did not answer for its records, so none can be copied. Only your address is set.' }
  if (copying.count === 0) return { available: false, detail: 'The current resolver holds no records this page lists, so there is nothing to copy. Your address is still set.' }
  const texts = Object.keys(copying.texts).length
  const parts = [copying.contenthash === null ? null : 'the contenthash', texts === 0 ? null : `${texts} text ${texts === 1 ? 'record' : 'records'}`].filter(Boolean)
  const skipped = copying.skipped.length === 0 ? '' : ` ${copying.skipped.length} could not be read and ${copying.skipped.length === 1 ? 'is' : 'are'} left out.`
  const rest = 'Records this page does not list are not copied, and your address record is always set.'
  return { available: true, detail: `Copies ${parts.join(' and ')} to your resolver. ${rest}${skipped}` }
}

/**
 * Where a move stands, from what `observeMove` read.
 * @typedef {object} Facts
 * @property {string} label
 * @property {string} holder
 * @property {string | null} current the resolver the registry names for the ID
 * @property {{ address: string, mode: 'deploy' | 'reuse' | 'blocked', why: string | null }} target the holder's own resolver
 * @property {RecordsRead | null} old the current resolver's records, while the ID still points at it
 * @property {RecordsRead | null} found the records of the holder's resolver for the ID, once it exists
 * @property {import('./sdk/orivonid.js').Attribution} attribution
 */

/** Whether the holder's resolver already carries what was chosen. @param {Copying} copying @param {RecordsRead} found */
function carries (copying, found) {
  if (!copying.readable) return true
  if (copying.contenthash !== null && (found.contenthash === null || toHex(found.contenthash) !== toHex(copying.contenthash))) return false
  return Object.entries(copying.texts).every(([key, value]) => found.texts[key] === value)
}

/**
 * The steps and which one is next. A step is done when the chain shows it: the resolver is there, it holds the ID's address
 * record (and the chosen copy), the registry names it. `next` is the first that is not done, whatever the person did before.
 * @param {Facts} facts
 * @param {{ copy: boolean }} choice
 */
export function planMove (facts, { copy }) {
  const copying = copy ? copySet(facts.old) : NOTHING
  const { holder, current, target, found } = facts
  const done = /** @type {Record<MoveStep, boolean>} */ ({
    deploy: target.mode === 'reuse',
    records: found !== null && found.addr !== null && sameAddress(found.addr, holder) && carries(copying, found),
    resolver: current !== null && sameAddress(current, target.address)
  })
  const steps = MOVE_ORDER.map((id) => ({
    id, ...MOVE_STEPS[id], group: /** @type {const} */ ('after'), state: /** @type {'done' | 'pending' | 'active' | 'failed'} */ (done[id] ? 'done' : 'pending'),
    hash: /** @type {string | null} */ (null)
  }))
  return {
    steps, copying, texts: copying.texts, contenthash: copying.contenthash,
    next: MOVE_ORDER.find((id) => !done[id]) ?? null,
    started: MOVE_ORDER.some((id) => done[id]) && MOVE_ORDER.some((id) => !done[id]),
    blocked: target.mode === 'blocked' && !done.resolver ? target.why : null
  }
}

/** The transaction of a step. @param {MoveStep} step @param {Facts} facts @param {ReturnType<typeof planMove>} plan @returns {Call} */
export function callFor (step, facts, plan) {
  if (step === 'deploy') return deployResolverTx(facts.holder)
  if (step === 'records') return recordsTx(facts.target.address, facts.label, facts.holder, plan.texts, plan.contenthash)
  return setResolverTx(facts.label, facts.target.address)
}

/** What a failed step means, where a bare "would fail on chain" says too little. @param {MoveStep | null} step @param {string} reason a REASONS name */
export function failureNote (step, reason) {
  if (reason !== 'reverted') return null
  if (step === 'deploy') return 'The factory refused to create your resolver.'
  if (step === 'records') return 'Your resolver refused the records.'
  if (step === 'resolver') return 'The registry refused to change the resolver. This address may not be allowed to.'
  return null
}

/** What the panel says when the registry names the new resolver and the chain still does not show the records held there. */
export const NOT_YET_HELD = 'The registry now names your resolver, but the chain does not yet show that you can write the ID’s records there. Check again in a moment.'

/** The words of the panel for one ID. @param {string} label */
export function moveWords (label) {
  const name = nameOf(label)
  return {
    title: 'Move to your own resolver',
    intro: `${name} points at a resolver you cannot change, so it cannot sign you in. A resolver of yours holds the same ID, and you can change its records.`,
    warnTitle: 'Before you move it',
    warnings: [
      `Moving ends every sign-in made with ${name}. A sign-in is tied to the resolver the ID had when it was made, so every site you signed in to with it will ask you to sign in again.`,
      'The old resolver keeps its copy of the records. Whoever controls it can still read them and change them, and nothing here deletes them.',
      `It does not change who holds ${name}.`
    ],
    steps: 'Each step is its own transaction, and your wallet asks you to confirm each one. Nothing is sent before you press the button.',
    copyLabel: 'Copy the current records',
    start: 'Move to your own resolver',
    resume: 'Continue the move',
    resumeNote: 'Part of this move is already done on chain. It continues from the first step that is not.',
    again: 'Try again',
    close: 'Close',
    cancel: 'Cancel',
    check: 'Check again'
  }
}
