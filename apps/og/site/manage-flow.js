// A change to a name the person holds, as a series sent one transaction at a time on the loop a registration uses (series-run.js). The
// plan comes from what the chain shows (manage-plan.js), so the request that starts a change also finishes one that stopped. Each step
// has its own rule before it is sent and its own check after its receipt: the registry answers a transfer by a non-holder with a success
// that does nothing, and a wrapper token that was sent is not a name the person still holds.

import { sameAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { CENSUS_KEYS, WRAPPER } from './resolver/og-pins.js'
import { planManage } from './manage-plan.js'
import { ZERO_KEY } from './names-model.js'
import { gateOf, holdsToken, is, offerOf, verifyAfter } from './register-flow.js'
import { readAfter, readFacts } from './register-reads.js'
import { classify, createSeries } from './series-run.js'

/** @typedef {import('./manage-plan.js').ManageRequest} ManageRequest */
/** @typedef {import('./register-plan.js').Step} Step */
/** @typedef {import('./register-plan.js').Facts} Facts */
/** @typedef {import('./series-run.js').Verdict} Verdict */

/** The text keys a change reads, so that the check after a step sees every record the name carries. */
export const MANAGE_KEYS = CENSUS_KEYS

/** @param {Facts} facts @param {string} account the account may write the name's records: it holds it, or it is the controller of a name it holds as a token */
const canWrite = (facts, account) => sameAddress(facts.registryOwner, account) || (sameAddress(facts.registryOwner, WRAPPER) && holdsToken(facts, account) && is(facts.controller, account))

/**
 * May this step be sent, given what the chain shows now?
 * @param {Step} step
 * @param {Facts} facts
 * @param {{ account: string, created: boolean }} context
 * @returns {Verdict}
 */
export function gateManage (step, facts, context) {
  const { account } = context
  const mine = sameAddress(facts.registryOwner, account)
  /** @type {(stop: import('./series-run.js').StopKind) => Verdict} */
  const stopped = (stop) => ({ ok: false, stop })
  switch (step.kind) {
    case 'unwrap': return sameAddress(facts.registryOwner, WRAPPER) && holdsToken(facts, account) && String(BigInt(facts.nameToId)) === step.tokenId ? { ok: true } : stopped('taken')
    case 'unsetController':
    case 'giveName': return mine ? { ok: true } : stopped('taken')
    case 'unsetRecord':
    case 'setPrimary': return canWrite(facts, account) ? { ok: true } : stopped('unsafe')
    case 'unsetPrimary': return { ok: true }
    case 'sendToken':
      if (!(sameAddress(facts.registryOwner, WRAPPER) && holdsToken(facts, account))) return stopped('taken')
      return String(BigInt(facts.nameToId)) === step.tokenId ? { ok: true } : stopped('unsafe')
    default: return gateOf(step, facts, context)
  }
}

/**
 * Did the step do what it is for, given what the chain shows at the block of its receipt?
 * @param {Step} step
 * @param {Facts} facts
 * @param {{ account: string }} context
 * @returns {Verdict}
 */
export function verifyManage (step, facts, context) {
  const { account } = context
  /** @type {(stop: import('./series-run.js').StopKind) => Verdict} */
  const bad = (stop) => ({ ok: false, stop })
  const lower = (/** @type {string | null | undefined} */ text) => (text ?? '').toLowerCase()
  switch (step.kind) {
    case 'unwrap': return sameAddress(facts.registryOwner, account) ? { ok: true } : bad('unexpected')
    case 'unsetController': return is(facts.controller, ZERO_ADDRESS) ? { ok: true } : bad('unexpected')
    case 'unsetRecord': return step.textKey !== undefined && (facts.values[step.textKey] ?? '') === '' ? { ok: true } : bad('unexpected')
    case 'setPrimary': return lower(facts.primary) === lower(facts.key) && is(facts.resolvesTo ?? null, account) ? { ok: true } : bad('unexpected')
    case 'unsetPrimary': return lower(facts.primary) === ZERO_KEY ? { ok: true } : bad('unexpected')
    case 'giveName': return step.to !== undefined && sameAddress(facts.registryOwner, step.to) ? { ok: true } : bad('unexpected')
    case 'sendToken': return step.to !== undefined && BigInt(facts.nameToId) !== 0n && lower(facts.idToName) === lower(facts.key) && is(facts.ownerOf, step.to) ? { ok: true } : bad('unexpected')
    default: return verifyAfter(step, facts, context)
  }
}

/**
 * @param {object} deps
 * @param {import('./sdk/chain.js').Chain} deps.chain
 * @param {import('./register-send.js').Sender} deps.sender
 * @param {(state: Record<string, any>) => void} deps.onState
 * @param {{ sleep: (ms: number) => Promise<void> }} [deps.clock]
 * @param {{ intervalMs?: number, timeoutMs?: number }} [deps.wait]
 */
export function createManage ({ chain, sender, onState, clock = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, wait = {} }) {
  const series = createSeries({ chain, sender, onState, clock, wait })

  /**
   * Plans from the chain and runs the plan. When there is nothing to send, the state ends in phase `refused` with the reason, and the
   * action that would put it right.
   * @param {ManageRequest} request
   * @returns {Promise<Record<string, any>>} the state the series ended in: phase `done`, `stopped` or `refused`
   */
  async function start (request) {
    const { label, account, action } = request
    const running = series.begin(
      { phase: 'checking', kind: 'manage', action, label, name: `${label}.og`, account, request },
      { gate: gateManage, verify: verifyManage, read: (block) => readAfter(chain, label, block, MANAGE_KEYS, clock, account), offer: (kind, facts, error) => offerOf(kind, facts, account, error) }
    )
    /** @type {Facts} */
    let facts
    try {
      facts = await readFacts(chain, label, 'latest', MANAGE_KEYS, account)
    } catch (error) {
      return running.stop(classify(error), null, { error, facts: /** @type {any} */ ({ registryOwner: ZERO_ADDRESS }) })
    }
    const plan = planManage(request, facts)
    if (plan.problem !== null) {
      running.emit({ phase: 'refused', problem: plan.problem, fix: plan.fix, situation: plan.situation, facts })
      return running.view()
    }
    const wrappedNow = plan.situation === 'wrappedMine' || plan.situation === 'stranded'
    const next = wrappedNow && !request.rewrap ? { ...request, rewrap: true } : request
    return await running.run({ steps: plan.steps, notes: plan.notes, facts, extra: { situation: plan.situation, request: next }, account, private: request.private === true })
  }

  return { start }
}
