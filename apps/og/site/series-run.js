// The loop every series of transactions here runs, for a registration and for a change to a name alike: the steps are signed (all at once
// when the wallet can, else as each turn comes), and then sent one at a time. Before a step the chain is read and checked against that
// step's rule; after its receipt it is read at the block the receipt names and checked against what the step should have done. A step
// that fails its check is not sent, and neither is anything after it. The rules, the facts and the words are the caller's.

import { ChainError } from './sdk/chain.js'
import { RelayError } from './relay.js'

/** @typedef {import('./register-plan.js').Step} Step */
/** @typedef {import('./register-plan.js').Facts} Facts */
/**
 * Why a series stopped. `declined`, `wouldFail`, `reverted`, `unknownOutcome` and `unavailable` are about a transaction; `taken`,
 * `wrapOff`, `wrapOffLate` and `unsafe` are the chain failing a check; `unexpected` is a transaction that was mined and did not do
 * what it should.
 * @typedef {'taken' | 'wrapOff' | 'wrapOffLate' | 'unsafe' | 'unexpected' | 'declined' | 'wouldFail' | 'reverted' | 'unknownOutcome' | 'unavailable'} StopKind
 */
/** @typedef {{ ok: true } | { ok: false, stop: StopKind }} Verdict */
/**
 * What a series is given besides its steps.
 * @typedef {object} Rules
 * @property {(step: Step, facts: Facts, context: { account: string, created: boolean }) => Verdict} gate may this step be sent, given the chain now
 * @property {(step: Step, facts: Facts, context: { account: string, created: boolean }) => Verdict} verify did it do what it is for, at its receipt's block
 * @property {(block: number) => Promise<Facts>} read the facts at a block a receipt names
 * @property {(kind: StopKind, facts: Facts, error?: unknown) => string | null} offer what the person can do after a stop of this kind, and of this error
 */

export const WAIT = Object.freeze({ intervalMs: 2000, timeoutMs: 240_000 })

/** @param {unknown} error @returns {StopKind} */
export function classify (error) {
  if (error instanceof RelayError) return error.maybeSent ? 'unknownOutcome' : 'unavailable'
  if (!(error instanceof ChainError)) return 'unavailable'
  if (error.reason === 'declined') return 'declined'
  if (error.reason === 'reverted') return 'wouldFail'
  if (error.reason === 'unknownOutcome' || error.reason === 'timeout') return error.hash === undefined ? 'unavailable' : 'unknownOutcome'
  return 'unavailable'
}

/**
 * @param {object} deps
 * @param {import('./sdk/chain.js').Chain} deps.chain
 * @param {import('./register-send.js').Sender} deps.sender
 * @param {(state: Record<string, any>) => void} deps.onState
 * @param {{ sleep: (ms: number) => Promise<void> }} [deps.clock]
 * @param {{ intervalMs?: number, timeoutMs?: number }} [deps.wait]
 */
export function createSeries ({ chain, sender, onState, clock = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, wait = {} }) {
  /**
   * Starts one series. The state it reports begins as `initial`; `run` fills in the steps and goes through them.
   * @param {Record<string, any>} initial the fields the caller's state carries: its phase, the name, the account
   * @param {Rules} rules
   */
  function begin (initial, rules) {
    /** @type {Record<string, any>} */
    let view = { ...initial, steps: [], notes: [], outcome: null, signing: null, costs: { gasUsed: 0, feeWei: 0n, tipWei: 0n } }
    /** @type {Facts | null} */
    let facts = null
    const emit = (/** @type {Record<string, any>} */ patch) => { view = { ...view, ...patch }; onState(view) }
    const setStep = (/** @type {number} */ index, /** @type {Record<string, any>} */ patch) => {
      emit({ steps: view['steps'].map((/** @type {Record<string, any>} */ one, /** @type {number} */ at) => at === index ? { ...one, ...patch } : one) })
    }
    /** @param {StopKind} kind @param {number | null} at @param {{ hash?: string | null, error?: unknown, facts?: Facts }} [more] */
    const stop = (kind, at, more = {}) => {
      const steps = /** @type {Record<string, any>[]} */ (view['steps'])
      const sent = steps.filter((one) => one['state'] === 'done').map((one) => one['id'])
      const where = at === null ? null : steps[at]?.['id'] ?? null
      emit({
        phase: 'stopped',
        steps: steps.map((one, index) => {
          if (at !== null && index === at && more.hash !== undefined && more.hash !== null) return { ...one, state: 'failed', sub: '' }
          return one['state'] === 'pending' || one['state'] === 'active' ? { ...one, state: 'dropped', sub: '' } : one
        }),
        outcome: {
          kind, at: where, sent, hash: more.hash ?? null, detail: more.error instanceof Error ? more.error.message : '',
          offer: rules.offer(kind, more.facts ?? /** @type {Facts} */ (facts), more.error)
        }
      })
      return view
    }

    /**
     * Signs and sends the steps. The facts are what the chain showed when the plan was made.
     * @param {object} plan
     * @param {readonly Step[]} plan.steps
     * @param {string[]} plan.notes
     * @param {Facts} plan.facts
     * @param {Record<string, any>} [plan.extra] more fields for the state
     * @param {string} plan.account
     * @param {boolean} plan.private whether to send through the private relay
     * @returns {Promise<Record<string, any>>} the state the series ended in: phase `done` or `stopped`
     */
    async function run ({ steps, notes, facts: first, extra = {}, account, private: priv }) {
      facts = first
      emit({
        phase: 'signing', notes, ...extra,
        steps: steps.map((step) => ({
          id: step.id, kind: step.kind, title: step.title, contract: step.contract, call: step.call, detail: step.detail, gas: step.gas,
          state: 'pending', sub: '', hash: null, gasUsed: null
        }))
      })
      if (steps.length === 0) {
        emit({ phase: 'done', facts })
        return view
      }
      try {
        const prepared = await sender.prepare(account, steps.map((step) => ({ ...step.tx, gas: step.gas })))
        emit({ phase: 'running', signing: prepared.signed ? 'series' : sender.kind === 'orivon' ? 'each' : 'extension' })
      } catch (error) {
        return stop(classify(error), 0, { error })
      }
      const context = { account, created: false }
      for (let index = 0; index < steps.length; index++) {
        const step = /** @type {Step} */ (steps[index])
        const gate = rules.gate(step, /** @type {Facts} */ (facts), context)
        if (!gate.ok) return stop(gate.stop, index)
        setStep(index, { state: 'active', sub: view['signing'] === 'series' ? 'sending' : 'waiting for your wallet' })
        /** @type {string} */
        let hash
        try {
          hash = await sender.send(index, account, { ...step.tx, gas: step.gas }, { private: priv })
        } catch (error) {
          const hashed = error instanceof ChainError || error instanceof RelayError ? error.hash ?? null : null
          return stop(classify(error), index, { error, hash: hashed })
        }
        setStep(index, { sub: 'waiting for it to be mined', hash })
        /** @type {import('./sdk/chain.js').Receipt} */
        let receipt
        try {
          receipt = await chain.waitForReceipt(hash, { intervalMs: wait.intervalMs ?? WAIT.intervalMs, timeoutMs: wait.timeoutMs ?? WAIT.timeoutMs, sleep: clock.sleep })
        } catch (error) {
          return stop(error instanceof ChainError && error.reason === 'timeout' ? 'unknownOutcome' : classify(error), index, { error, hash })
        }
        const fee = BigInt(receipt.gasUsed) * receipt.effectiveGasPrice
        const costs = view['costs']
        emit({ costs: { gasUsed: costs.gasUsed + receipt.gasUsed, feeWei: costs.feeWei + fee, tipWei: step.kind === 'tip' && receipt.status === 1 ? step.tx.value ?? 0n : costs.tipWei } })
        setStep(index, { gasUsed: receipt.gasUsed })
        if (receipt.status !== 1) return stop('reverted', index, { hash })
        if (step.kind === 'createWrapper') context.created = true
        setStep(index, { sub: 'checking the result' })
        try {
          facts = await rules.read(receipt.blockNumber)
        } catch (error) {
          return stop('unavailable', index, { error, hash })
        }
        const checked = rules.verify(step, facts, context)
        if (!checked.ok) return stop(checked.stop, index, { hash })
        setStep(index, { state: 'done', sub: '' })
      }
      emit({ phase: 'done', facts })
      return view
    }

    onState(view)
    return { emit, stop, run, view: () => view }
  }

  return { begin }
}
