// What the registration panel draws for each state of the flow (register-flow.js), as plain data: a heading, one
// line for a screen reader, the steps with their transactions, the countdown and the buttons. Pure.

import { REASONS } from './register-reasons.js'
import { MIN_COMMITMENT_AGE } from './register-tx.js'
import { RELAY_WORDS } from './relay.js'
import { formatClock, formatDai } from './words.js'

/** @typedef {'commit' | 'approve' | 'deploy' | 'register' | 'records'} Step */
/** @typedef {'pending' | 'active' | 'done' | 'failed'} StepState */

export const ORDER = /** @type {readonly Step[]} */ (['commit', 'approve', 'deploy', 'register', 'records'])

/** What each transaction is for, in the words beside it. */
export const STEP_WORDS = Object.freeze({
  commit: { title: 'Commit', detail: 'Publishes only a fingerprint of your choice. Nobody can see the name in it, so nobody can take it before you.' },
  approve: { title: 'Approve DAI', detail: 'Lets the registrar take exactly the price in DAI from your wallet, once.' },
  deploy: { title: 'Create your resolver', detail: 'A small contract of yours that holds the records of your names. It is made once and reused.' },
  register: { title: 'Register', detail: 'Sent as soon as the commitment is a minute old. This is the transaction that pays and gives you the name.' },
  records: { title: 'Set your records', detail: 'Points the name at your address, so a site can check that it is yours.' }
})

const WAITING_ON = Object.freeze({
  estimating: 'Checking the transaction with your node',
  signing: 'Waiting for your wallet to sign',
  broadcasting: 'Sending it to the network',
  mining: 'Waiting for it to be included in a block'
})

/** What a send is waiting on, in words. @param {unknown} sending */
export const sendingWords = (sending) => WAITING_ON[/** @type {keyof typeof WAITING_ON} */ (sending)] ?? 'Working'

/** The wait groups the steps by when they happen. @type {Readonly<Record<Step, 'before' | 'wait' | 'after'>>} */
const GROUP = Object.freeze({ commit: 'before', approve: 'wait', deploy: 'wait', register: 'after', records: 'after' })

/** How far along the flow is, so a step that left no hash can still be known to be done. */
const RANK = Object.freeze({ checking: -1, ready: -1, committing: 0, maturing: 1, revealing: 2, recording: 3, verifying: 4, done: 5, failed: 0 })

/**
 * The steps the page knows will happen: the plan the check made, what already left a hash, and the one in hand.
 * @param {Record<string, any>} state
 * @param {readonly string[] | null} plan
 * @returns {Step[]}
 */
export function knownSteps (state, plan) {
  const named = new Set([...(plan ?? []), ...Object.keys(state['hashes'] ?? {}), ...(typeof state['step'] === 'string' ? [state['step']] : [])])
  return ORDER.filter((step) => step === 'commit' || step === 'register' || step === 'records' || named.has(step))
}

/**
 * The hashes of every state so far. A state that reports a failure carries none, and what was sent before it is still sent.
 * @param {Record<string, string>} previous
 * @param {Record<string, any>} state
 * @returns {Record<string, string>}
 */
export const trackHashes = (previous, state) => ({ ...previous, ...(state['hashes'] ?? {}) })

/**
 * The plan to keep after a state arrives: the one the state carries (the check makes it, and a registration picked up
 * after a reload makes it again from the chain), none while a name is being checked, the previous one otherwise.
 * @param {readonly string[] | null} previous
 * @param {Record<string, any>} state
 * @returns {readonly string[] | null}
 */
export function trackPlan (previous, state) {
  if (Array.isArray(state['transactions'])) return state['transactions']
  return state['phase'] === 'checking' && state['what'] === 'name' ? null : previous
}

/**
 * @param {Record<string, any>} state
 * @param {readonly string[] | null} plan
 * @param {Record<string, string>} [known] hashes seen in earlier states
 * @returns {{ id: Step, title: string, detail: string, group: 'before' | 'wait' | 'after', state: StepState, hash: string | null }[]}
 */
export function stepsOf (state, plan, known = {}) {
  const phase = /** @type {keyof typeof RANK} */ (state['phase'])
  const failed = phase === 'failed'
  const rank = RANK[/** @type {keyof typeof RANK} */ (failed ? state['during'] : phase)] ?? 0
  const hashes = /** @type {Record<string, string>} */ ({ ...known, ...(state['hashes'] ?? {}) })
  const implied = /** @type {Record<Step, number>} */ ({ commit: 1, approve: 2, deploy: 99, register: 3, records: 4 })
  return knownSteps({ ...state, hashes }, plan).map((id) => {
    const current = state['step'] === id
    /** @type {StepState} */
    let stateOfStep = 'pending'
    if (current && failed) stateOfStep = 'failed'
    else if (current && state['sending'] !== undefined && phase !== 'done') stateOfStep = 'active'
    else if (hashes[id] !== undefined || rank >= implied[id]) stateOfStep = 'done'
    const hash = hashes[id] ?? (current && typeof state['hash'] === 'string' ? state['hash'] : null)
    return { id, ...STEP_WORDS[id], group: GROUP[id], state: stateOfStep, hash }
  })
}

/**
 * @typedef {{ matureAt: number, blockTimestamp: number, receivedAt: number }} Timing
 * The commitment's maturity time and the newest block time seen with it, and when (in ms) that state arrived.
 */

/**
 * The timing to keep after a state arrives: the state's own when it carries one (only the states made by `decide` do,
 * not the ones a send emits), none once the wait is over, the previous one otherwise.
 * @param {Timing | null} previous
 * @param {Record<string, any>} state
 * @param {number} nowMs
 * @returns {Timing | null}
 */
export function trackTiming (previous, state, nowMs) {
  if (typeof state['matureAt'] === 'number' && typeof state['blockTimestamp'] === 'number') {
    return { matureAt: state['matureAt'], blockTimestamp: state['blockTimestamp'], receivedAt: nowMs }
  }
  return state['phase'] === 'maturing' || state['phase'] === 'committing' ? previous : null
}

/**
 * Seconds left of the maturity wait: the chain's maturity time less the block time last read and the time since, so
 * the number moves between polls but is the chain's, not the computer's clock.
 * @param {Timing | null} timing
 * @param {number} nowMs
 * @returns {{ remaining: number, total: number, text: string, done: boolean } | null}
 */
export function countdown (timing, nowMs) {
  if (timing === null) return null
  const remaining = Math.min(MIN_COMMITMENT_AGE, Math.max(0, timing.matureAt - timing.blockTimestamp - Math.floor((nowMs - timing.receivedAt) / 1000)))
  return { remaining, total: MIN_COMMITMENT_AGE, text: formatClock(remaining), done: remaining === 0 }
}

/** @param {Record<string, any>} state */
function statusOf (state) {
  const name = String(state['name'] ?? 'the name')
  switch (state['phase']) {
    case 'checking':
      if (state['what'] === 'chain') return 'Reading the chain to see where this registration stands.'
      if (state['what'] === 'expired') return 'The commitment ran out. Checking the name again.'
      return 'Checking the name, the sale and your DAI balance.'
    case 'ready': return `Ready to register ${name} for ${formatDai(state['price'])}.`
    case 'committing': return `Step 1: committing. ${sendingWords(state['sending'])}.`
    case 'maturing':
      if (state['step'] === 'approve') return `While the commitment matures: approving DAI. ${sendingWords(state['sending'])}.`
      if (state['step'] === 'deploy') return `While the commitment matures: creating your resolver. ${sendingWords(state['sending'])}.`
      return 'Waiting for the commitment to be a minute old.'
    case 'revealing': return `Registering ${name}. ${sendingWords(state['sending'])}.`
    case 'recording': return `Setting the records of ${name}. ${sendingWords(state['sending'])}.`
    case 'verifying': return `Reading ${name} back to check that it resolves to your address.`
    case 'done': return `${name} is yours. A site can now check that it belongs to your address.`
    case 'failed': return 'The registration stopped.'
    default: return ''
  }
}

/**
 * @typedef {object} Action
 * @property {'register' | 'edit' | 'check' | 'retry' | 'public' | 'private' | 'continue' | 'forget' | 'another' | 'mine' | 'connect' | 'signin'} id
 * @property {string} label
 * @property {boolean} [primary]
 */

/** What a stored registration got wrong (`mismatch` of a `recordDiscarded` failure), in the words after "It did not match in". */
export const MISMATCH_WORDS = Object.freeze({
  label: 'the name', price: 'the price', commitment: 'the commitment', owner: 'the wallet it was made with', resolver: 'the resolver'
})

/** @param {unknown} mismatch @returns {string | null} */
const mismatchNote = (mismatch) => typeof mismatch === 'string' ? `It did not match in ${/** @type {Record<string, string>} */ (MISMATCH_WORDS)[mismatch] ?? 'something it holds'}.` : null

/** What can be done about a failure. @param {Record<string, any>} state @returns {Action[]} */
export function failureActions (state) {
  const reason = String(state['reason'])
  if (reason === 'recordDiscarded') return [{ id: 'edit', label: 'Start again', primary: true }]
  if (state['offerPublic'] === true) {
    return [{ id: 'public', label: RELAY_WORDS.sendPublicly, primary: true }, { id: 'private', label: 'Try the private relay again' }]
  }
  if (reason === 'pendingExists') return [{ id: 'continue', label: 'Continue that registration', primary: true }, { id: 'forget', label: 'Forget it' }]
  if (reason === 'noWallet') return [{ id: 'connect', label: 'Connect', primary: true }]
  if (reason === 'taken' || REASONS[reason]?.recover === 'edit') return [{ id: 'edit', label: 'Change the name', primary: true }]
  const checking = state['during'] === 'checking'
  if (checking) return [{ id: 'check', label: REASONS[reason]?.recover === 'retry' ? 'Try again' : 'Check again', primary: true }, { id: 'edit', label: 'Change the name' }]
  if (REASONS[reason]?.recover === 'retry') return [{ id: 'retry', label: 'Try again', primary: true }]
  return []
}

/** Whether a failure leaves a transaction that may still be mined, which a retry must not duplicate. @param {Record<string, any>} state */
const mayStillLand = (state) => typeof state['hash'] === 'string' && (state['pendingStatus'] === 'timedOut' || state['reason'] === 'unknownOutcome' || state['reason'] === 'notMined')

/**
 * @typedef {object} PanelView
 * @property {string} phase
 * @property {'busy' | 'ok' | 'bad' | 'neutral'} tone
 * @property {string} heading
 * @property {string} status the sentence a screen reader hears when the state changes
 * @property {boolean} busy
 * @property {ReturnType<typeof stepsOf>} steps
 * @property {ReturnType<typeof countdown>} timer
 * @property {{ words: string, detail: string, hash: string | null, hashNote: string | null, note: string | null } | null} failure `note` says what a discarded stored registration got wrong
 * @property {Action[]} actions
 * @property {{ advised: boolean } | null} privateChoice shown while the person can still choose
 * @property {{ price: string, balance: string, transactions: number } | null} summary
 */

/**
 * @param {Record<string, any>} state a state of `createRegistration(...)`
 * @param {{ plan: readonly string[] | null, timing: Timing | null, nowMs: number, hashes?: Record<string, string>, name?: string }} context
 * @returns {PanelView}
 */
export function panelView (state, context) {
  const phase = String(state['phase'])
  const name = state['name'] === undefined ? (context.name ?? '') : String(state['name'])
  const failed = phase === 'failed'
  const noSteps = failed && (state['during'] === 'checking' || state['reason'] === 'recordDiscarded')
  const steps = phase === 'checking' || noSteps ? [] : stepsOf(state, context.plan, context.hashes)
  /** @type {PanelView['tone']} */
  const tone = failed ? 'bad' : phase === 'done' ? 'ok' : phase === 'ready' ? 'neutral' : 'busy'
  const heading = phase === 'done' ? 'Registration complete' : phase === 'ready' ? `Register ${name}` : name === '' ? 'Registration' : `Registering ${name}`
  const failure = failed
    ? {
        words: String(state['words'] ?? REASONS['unavailable']?.words ?? ''),
        detail: String(state['detail'] ?? ''),
        hash: typeof state['hash'] === 'string' ? state['hash'] : null,
        hashNote: mayStillLand(state) ? 'This transaction may still be mined. Check your wallet or the chain before sending another.' : null,
        note: state['reason'] === 'recordDiscarded' ? mismatchNote(state['mismatch']) : null
      }
    : null
  /** @type {Action[]} */
  let actions = []
  if (phase === 'ready') actions = [{ id: 'register', label: `Register for ${formatDai(state['price'])}`, primary: true }]
  else if (failed) actions = failureActions(state)
  else if (phase === 'done') actions = [{ id: 'mine', label: 'See my IDs', primary: true }, { id: 'another', label: 'Register another name' }]
  return {
    phase, tone, heading, status: statusOf(state), busy: !failed && phase !== 'done' && phase !== 'ready', steps,
    timer: phase === 'maturing' ? countdown(context.timing, context.nowMs) : null, failure, actions,
    privateChoice: phase === 'ready' ? { advised: state['advisePrivate'] === true } : null,
    summary: phase === 'ready'
      ? { price: formatDai(state['price']), balance: formatDai(state['balance']), transactions: Array.isArray(state['transactions']) ? state['transactions'].length : 0 }
      : null
  }
}
