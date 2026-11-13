// The registration as a series sent one transaction at a time. The plan comes from what the chain shows (register-plan.js), so the
// same function that starts a registration also finishes one that stopped. Before each step the chain is read and checked against
// that step's rule; after each receipt it is read at the block the receipt names and checked against what the step should have done.
// A step that fails its check is not sent, and nothing after it is: the registry answers a taken name with a success that does
// nothing, and a transfer to the wrapper that no `createWrapper` came before leaves the name stuck there for good. The tip is the
// last step and is reached only when every step before it worked.

import { sameAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { WRAPPER } from './resolver/og-pins.js'
import { planSeries, situationOf } from './register-plan.js'
import { readAfter, readFacts } from './register-reads.js'
import { settleTip } from './register-tip.js'
import { RelayError } from './relay.js'
import { classify, createSeries, WAIT } from './series-run.js'

export { WAIT }

/** @param {string | null} address @param {string} other */
export const is = (address, other) => address !== null && sameAddress(address, other)

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {import('./register-plan.js').Step} Step */
/** @typedef {import('./register-plan.js').Facts} Facts */
/** @typedef {import('./register-send.js').Sender} Sender */
/**
 * @typedef {object} Request
 * @property {string} label
 * @property {string} account
 * @property {boolean} wrapped whether to end with the wrapper's token
 * @property {{ key: string, text: string } | null} site
 * @property {{ to: string, wei: bigint, name: string, gas?: number } | null} tip
 * @property {boolean} private whether to send through the private relay
 * @property {readonly string[]} [notes] what the page has to tell the person about the request, said with the series: a tip it left out, and why
 * @property {Earlier} [earlier] what the runs of this request before this one left, which the flow fills in
 */
/**
 * What a run leaves for the next one, which is the same request pressed again after a stop.
 * @typedef {object} Earlier
 * @property {string[]} done the ids of the steps that were sent and passed their check
 * @property {{ hash: string | null, maybeSent: boolean } | null} tip the tip transaction the runs reached, null when they reached none: its hash
 *   when there is one, and whether it may have gone out
 */
/** @typedef {import('./series-run.js').StopKind} StopKind */

/**
 * Whether the wrapper issued a token for the name to `account`.
 * @param {Facts} facts
 * @param {string} account
 */
export const holdsToken = (facts, account) => BigInt(facts.nameToId) !== 0n && facts.idToName?.toLowerCase() === facts.key.toLowerCase() && is(facts.ownerOf, account)

/**
 * May this step be sent, given what the chain shows now?
 * @param {Step} step
 * @param {Facts} facts
 * @param {{ account: string, created: boolean }} context `created`: this series saw `createWrapper` succeed
 * @returns {{ ok: true } | { ok: false, stop: StopKind }}
 */
export function gateOf (step, facts, context) {
  const { account } = context
  const mine = sameAddress(facts.registryOwner, account)
  const stopped = (/** @type {StopKind} */ stop) => ({ ok: /** @type {const} */ (false), stop })
  switch (step.kind) {
    case 'reserve': return sameAddress(facts.registryOwner, ZERO_ADDRESS) ? { ok: true } : stopped('taken')
    case 'setController': return mine ? { ok: true } : stopped('taken')
    case 'createWrapper':
      if (!mine) return stopped('taken')
      return facts.wrapEnabled === true ? { ok: true } : stopped('wrapOff')
    case 'transfer': return context.created && mine && is(facts.waitForWrap, account) ? { ok: true } : stopped('unsafe')
    case 'wrap':
      if (!sameAddress(facts.registryOwner, WRAPPER) || !is(facts.waitForWrap, account)) return stopped('unsafe')
      return facts.wrapEnabled === true ? { ok: true } : stopped('wrapOffLate')
    case 'record': return mine || (sameAddress(facts.registryOwner, WRAPPER) && holdsToken(facts, account) && is(facts.controller, account)) ? { ok: true } : stopped('unsafe')
    default: return { ok: true }
  }
}

/**
 * Did the step do what it is for, given what the chain shows at the block of its receipt?
 * @param {Step} step
 * @param {Facts} facts
 * @param {{ account: string }} context
 * @returns {{ ok: true } | { ok: false, stop: StopKind }}
 */
export function verifyAfter (step, facts, context) {
  const { account } = context
  const bad = (/** @type {StopKind} */ stop) => ({ ok: /** @type {const} */ (false), stop })
  switch (step.kind) {
    case 'reserve': return sameAddress(facts.registryOwner, account) ? { ok: true } : bad('taken')
    case 'setController': return is(facts.controller, account) ? { ok: true } : bad('unexpected')
    case 'createWrapper': return is(facts.waitForWrap, account) ? { ok: true } : bad('unexpected')
    case 'transfer': return sameAddress(facts.registryOwner, WRAPPER) ? { ok: true } : bad('unexpected')
    case 'wrap': return holdsToken(facts, account) ? { ok: true } : bad('unexpected')
    case 'record': return step.textKey !== undefined && facts.values[step.textKey] === step.value ? { ok: true } : bad('unexpected')
    default: return { ok: true }
  }
}

/**
 * What the next run of the request is told about this one: the steps that finished, and where the tip stands.
 * @param {Earlier} before
 * @param {Record<string, any>} ended the state the run ended in
 * @returns {Earlier}
 */
function carried (before, ended) {
  const steps = /** @type {Record<string, any>[]} */ (ended['steps'])
  const done = [...new Set([...before.done, ...steps.filter((step) => step['state'] === 'done').map((step) => String(step['id']))])]
  const tipStep = steps.find((step) => step['kind'] === 'tip')
  const outcome = ended['outcome']
  if (tipStep?.['state'] === 'done') return { done, tip: { hash: tipStep['hash'] ?? null, maybeSent: true } }
  if (outcome === null || outcome === undefined || outcome['at'] !== 'tip') return { done, tip: before.tip }
  const hash = outcome['hash'] ?? tipStep?.['hash'] ?? null
  return { done, tip: { hash, maybeSent: hash !== null || outcome['kind'] === 'unknownOutcome' } }
}

/**
 * @param {object} deps
 * @param {Chain} deps.chain
 * @param {Sender} deps.sender
 * @param {(state: Record<string, any>) => void} deps.onState
 * @param {{ sleep: (ms: number) => Promise<void> }} [deps.clock]
 * @param {{ intervalMs?: number, timeoutMs?: number }} [deps.wait]
 */
export function createRegistration ({ chain, sender, onState, clock = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, wait = {} }) {
  const series = createSeries({ chain, sender, onState, clock, wait })

  /**
   * Plans from the chain and runs the plan: a registration, the rest of one that stopped, or the finish of a name the wrapper holds.
   * @param {Request} request
   * @returns {Promise<Record<string, any>>} the state the series ended in: phase `done` or `stopped`
   */
  async function start (request) {
    const { label, account } = request
    const keys = request.site === null ? [] : [request.site.key]
    const running = series.begin(
      { phase: 'checking', kind: 'register', label, name: `${label}.og`, account },
      { gate: gateOf, verify: verifyAfter, read: (block) => readAfter(chain, label, block, keys, clock), offer: (kind, facts, error) => offerOf(kind, facts, account, error) }
    )
    /** @type {Facts} */
    let facts
    try {
      facts = await readFacts(chain, label, 'latest', keys)
    } catch (error) {
      return running.stop(classify(error), null, { error, facts: /** @type {any} */ ({ registryOwner: ZERO_ADDRESS }) })
    }
    const situation = situationOf(facts, account)
    if (situation === 'taken') return running.stop('taken', null, { facts })
    if ((situation === 'stranded' || (request.wrapped && (situation === 'free' || situation === 'mine'))) && facts.wrapEnabled !== true) {
      return running.stop(situation === 'stranded' ? 'wrapOffLate' : 'wrapOff', null, { facts })
    }
    const earlier = request.earlier ?? { done: [], tip: null }
    const settled = await settleTip(chain, earlier.tip)
    const tip = settled.status === 'open' ? request.tip : null
    const planned = planSeries({ label, account, facts, wrapped: request.wrapped, site: request.site, tip, done: earlier.done, tipOwed: earlier.tip !== null })
    const notes = [...(request.notes ?? []), ...planned.notes, ...(settled.words === null ? [] : [settled.words])]
    const ended = await running.run({ steps: planned.steps, notes, facts, extra: { situation }, account, private: request.private })
    running.emit({ request: { ...request, earlier: carried(earlier, ended) } })
    return running.view()
  }

  return { start }
}

/**
 * What the person can do after a stop, from what the chain shows.
 * @param {StopKind} kind
 * @param {Facts} facts
 * @param {string} account
 * @param {unknown} [error] what stopped it: a private relay that failed is answered by sending publicly, not by asking the same relay again
 * @returns {'unwrapped' | 'finishWrapping' | 'retry' | 'public' | null}
 */
export function offerOf (kind, facts, account, error) {
  if (error instanceof RelayError) return 'public'
  if (kind === 'taken') return null
  if (kind === 'wrapOff') return sameAddress(facts.registryOwner, account) || sameAddress(facts.registryOwner, ZERO_ADDRESS) ? 'unwrapped' : null
  return kind === 'wrapOffLate' ? 'finishWrapping' : 'retry'
}
