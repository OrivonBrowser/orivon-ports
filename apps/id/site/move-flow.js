// The move of an ID to its holder's own resolver, run against the chain. `check` reads where the move stands and answers
// the offer, a refusal, or that nothing is left to do; `run` sends the first step that is not done, reads the chain
// again, and goes on until the registry names the resolver and the holder can write the ID's records there. It keeps no
// record of its own: every turn starts from what the chain shows, so a page that reloaded halfway simply runs again.

import { ChainError } from './sdk/chain.js'
import { callFor, failureNote, NOT_YET_HELD, planMove } from './move-model.js'
import { observeMove } from './move-reads.js'
import { moveOffer } from './offer-model.js'
import { serialPerAccount } from './register-flow.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { withMargin } from './register-tx.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {import('./move-model.js').MoveStep} MoveStep */
/** @typedef {import('./move-model.js').Facts} Facts */
/** @typedef {{ copy: boolean }} Choice */

export const POLL_MS = 4000
export const PENDING_TIMEOUT_MS = 180_000
export const VERIFY_TRIES = 4
const MAX_TURNS = 12

/**
 * @param {object} deps
 * @param {Chain} deps.chain
 * @param {import('./register-flow.js').Broadcaster} deps.broadcaster the same signing and sending path a registration uses
 * @param {import('./register-flow.js').Clock} deps.clock
 * @param {string[]} deps.keys the text records to read from both resolvers
 * @param {(state: Record<string, any>) => void} [deps.onState]
 * @param {number} [deps.pollMs]
 * @param {number} [deps.pendingTimeoutMs]
 * @param {number} [deps.verifyTries]
 */
export function createMove (deps) {
  const { chain, broadcaster, clock, keys, onState = () => {}, pollMs = POLL_MS, pendingTimeoutMs = PENDING_TIMEOUT_MS, verifyTries = VERIFY_TRIES } = deps
  /** @type {Record<string, any>} */
  let current = { phase: 'idle' }
  let floor = 0
  /** @type {Partial<Record<MoveStep, string>>} */
  const hashes = {}
  /** @type {Partial<Record<MoveStep, number>>} */
  const gasUsed = {}

  /** @param {Record<string, any>} state */
  function emit (state) {
    current = state
    onState(state)
    return state
  }

  /**
   * The state to draw, with the plan the chain implies. A step in hand is active, or failed once it failed.
   * @param {string} phase @param {Facts} facts @param {Choice} choice @param {Record<string, any>} [extra]
   */
  function stateOf (phase, facts, choice, extra = {}) {
    const plan = planMove(facts, choice)
    const steps = plan.steps.map((one) => ({
      ...one, hash: hashes[one.id] ?? null,
      state: extra['step'] === one.id && one.state !== 'done' ? (phase === 'failed' ? 'failed' : 'active') : one.state
    }))
    return { phase, label: facts.label, holder: facts.holder, facts, plan: { ...plan, steps }, gas: { ...gasUsed }, hashes: { ...hashes }, ...extra }
  }

  /** Reads the chain once it shows the last transaction this move mined. @param {string} label @param {string} holder */
  async function read (label, holder) {
    for (let waited = 0; waited < 30; waited++) {
      const head = await chain.getBlock('latest')
      if (head === null) throw new ChainError('unavailable', 'the node has no newest block')
      if (head.number >= floor) return await observeMove(chain, label, holder, { keys })
      await clock.sleep(1000)
    }
    throw new ChainError('unavailable', 'the node did not catch up with the last transaction of the move')
  }

  /** @param {string} label @param {string} holder @param {unknown} error @param {string} during */
  function unreadable (label, holder, error, during) {
    const found = reasonOfError(error)
    return emit({ phase: 'failed', label, holder, reason: found.reason, detail: found.detail, words: REASONS[found.reason]?.words ?? found.detail, hash: null, during })
  }

  /**
   * @param {Facts} facts @param {Choice} choice @param {MoveStep | null} step @param {string} during
   * @param {unknown} error what a step threw
   * @param {string} [words] what to say instead of the words of the reason
   */
  function failed (facts, choice, step, during, error, words) {
    const found = reasonOfError(error)
    const hash = error instanceof ChainError ? error.hash : undefined
    const reason = error instanceof ChainError && error.reason === 'timeout' && hash !== undefined ? 'notMined' : found.reason
    const said = words ?? [REASONS[reason]?.words, failureNote(step, reason)].filter(Boolean).join(' ')
    const sent = hash ?? (step === null ? null : hashes[step] ?? null)
    return emit(stateOf('failed', facts, choice, { step, reason, detail: found.detail, words: said, hash: sent, during }))
  }

  /** The offer, or why there is none. @param {Facts} facts @param {Choice} choice */
  function settle (facts, choice) {
    const offer = moveOffer(facts.attribution)
    if (!offer.offered && offer.reason === 'held') return emit(stateOf('done', facts, choice))
    const who = { label: facts.label, holder: facts.holder }
    if (!offer.offered) return emit({ phase: 'refused', ...who, reason: offer.reason, words: offer.words, retry: offer.retry })
    const blocked = planMove(facts, choice).blocked
    const words = REASONS['resolverBlocked']?.words
    if (blocked !== null) return emit({ phase: 'refused', ...who, reason: 'resolverBlocked', words, detail: blocked, retry: false })
    return emit(stateOf('ready', facts, choice))
  }

  /**
   * One transaction: estimated like a public reveal, signed and sent through the broadcaster, and waited for. One send of
   * one account runs at a time, so two never share a nonce.
   * @param {MoveStep} step @param {Facts} facts @param {Choice} choice
   */
  async function sendStep (step, facts, choice) {
    const call = callFor(step, facts, planMove(facts, choice))
    await serialPerAccount(facts.holder, async () => {
      const tx = { from: facts.holder, to: call.to, data: call.data }
      emit(stateOf('running', facts, choice, { step, sending: 'estimating' }))
      const gas = withMargin(await chain.estimateGas(tx))
      emit(stateOf('running', facts, choice, { step, sending: 'signing' }))
      const prepared = await broadcaster.prepare({ ...tx, gas })
      if (prepared.hash !== null) hashes[step] = prepared.hash
      emit(stateOf('running', facts, choice, { step, sending: 'broadcasting' }))
      const hash = await prepared.send({ private: false })
      hashes[step] = hash
      emit(stateOf('running', facts, choice, { step, sending: 'mining' }))
      const receipt = await chain.waitForReceipt(hash, { timeoutMs: pendingTimeoutMs, intervalMs: pollMs, sleep: clock.sleep, now: clock.now })
      floor = Math.max(floor, receipt.blockNumber)
      gasUsed[step] = receipt.gasUsed
      if (receipt.status !== 1) throw new ChainError('reverted', `${step} was mined and reverted`, { hash })
    })
  }

  return {
    state: () => current,

    /** Reads where the move stands. @param {string} label @param {string} holder @param {Choice} [choice] */
    async check (label, holder, choice = { copy: true }) {
      emit({ phase: 'checking', label, holder })
      try {
        return settle(await read(label, holder), choice)
      } catch (error) {
        return unreadable(label, holder, error, 'reading')
      }
    },

    /** Sends every step the chain does not show as done, in order, and answers `done` once the holder can write the records. @param {string} label @param {string} holder @param {Choice} choice */
    async run (label, holder, choice) {
      let verifying = 0
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        /** @type {Facts} */
        let facts
        try {
          facts = await read(label, holder)
        } catch (error) {
          return unreadable(label, holder, error, 'reading')
        }
        const offer = moveOffer(facts.attribution)
        if (!offer.offered && offer.reason !== 'held') return settle(facts, choice)
        const plan = planMove(facts, choice)
        if (plan.next === null) {
          if (facts.attribution.records.ok) return emit(stateOf('done', facts, choice))
          if (++verifying > verifyTries) return failed(facts, choice, null, 'verifying', new ChainError('badAnswer', 'the records are not yet held on the new resolver'), NOT_YET_HELD)
          emit(stateOf('verifying', facts, choice))
          await clock.sleep(pollMs)
          continue
        }
        if (plan.blocked !== null) return settle(facts, choice)
        try {
          await sendStep(plan.next, facts, choice)
        } catch (error) {
          return failed(facts, choice, plan.next, 'sending', error)
        }
      }
      return unreadable(label, holder, new ChainError('unavailable', 'the move made no progress'), 'running')
    }
  }
}
