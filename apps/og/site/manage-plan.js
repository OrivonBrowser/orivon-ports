// The transactions a change to a held name needs, from what the chain shows now. Pure. As with a registration, the plan is a function of
// the chain, so the same request that starts a change also finishes one that stopped: a guided series that stopped after the unwrap
// leaves a name the account holds in the registry, and the same request plans what is left. Nothing here calls a registry setter
// (`setContent`, `setAddress`, `setSubRegistrar`): each emits `Changed`, which makes every record of the name stop counting.

import { isAddress, sameAddress, toChecksumAddress, ZERO_ADDRESS } from './sdk/abi.js'
import { CONTRACT_KEY, PROXY, REGISTRY, WRAPPER } from './resolver/og-pins.js'
import { labelProblem } from './resolver/og-name.js'
import { labelOfKey } from './names-model.js'
import {
  controllerStep, createWrapperStep, GAS, handOverStep, RESOLVER_NAME, recordStep, REGISTRY_NAME, situationOf, WRAPPER_NAME, wrapStep
} from './register-plan.js'
import { setPrimaryTx, unsetControllerTx, unsetPrimaryTx, unsetTextTx, unwrapTx, sendTokenTx, transferTx } from './register-tx.js'
import { shortAddress, SPELLING_WORDS } from './words.js'

/** @typedef {import('./register-plan.js').Step} Step */
/** @typedef {import('./register-plan.js').Facts} Facts */
/** @typedef {'setSite' | 'reconfirm' | 'clear' | 'setPrimary' | 'fixController' | 'cleanUp' | 'transfer' | 'wrap' | 'unwrap'} Action */
/**
 * What the person asked for. Only the fields of its action are read.
 * @typedef {object} ManageRequest
 * @property {Action} action
 * @property {string} label
 * @property {string} account
 * @property {boolean} [private] whether to send through the private relay
 * @property {{ key: string, text: string } | null} [site] setSite: the record of the site
 * @property {string | null} [contract] setSite: the address a web3:// site is served from
 * @property {readonly string[]} [keys] reconfirm, clear: the text keys
 * @property {readonly { key: string, text: string }[]} [keep] wrap, unwrap: the records that count now, written again afterwards
 * @property {boolean} [rewrap] fixController, cleanUp: the name was wrapped when the person started, so a name that is unwrapped now is wrapped again
 * @property {string} [to] transfer: who receives the name
 * @property {boolean} [unsetController] transfer: remove the controller first
 * @property {boolean} [unsetPrimary] transfer: end the account's primary name first, when it is this one
 */
/** @typedef {{ situation: ReturnType<typeof situationOf>, steps: Step[], notes: string[], problem: string | null, fix: Action | null }} Plan */

export const WRAP_OFF_WORDS = 'Wrapping is switched off at the wrapper, so a name cannot be wrapped for now. Nothing was changed. Come back when it is on.'

/** @param {string | null} address @param {string} other */
const is = (address, other) => address !== null && sameAddress(address, other)

/**
 * Why a name cannot be given to `to`, in words, or null when it can.
 * @param {unknown} to
 * @param {string} account
 * @returns {string | null}
 */
export function transferProblem (to, account) {
  const text = typeof to === 'string' ? to.trim() : ''
  if (text === '') return 'Enter the address to give it to.'
  if (!isAddress(text)) return 'That is not an Ethereum address: 0x and 40 letters or digits, and if it mixes capitals and small letters, they have to be right.'
  if (sameAddress(text, ZERO_ADDRESS)) return 'The zero address would free the name for anyone to take, not give it to someone.'
  if (sameAddress(text, account)) return 'That is your own address.'
  if ([REGISTRY, PROXY, WRAPPER].some((contract) => sameAddress(text, contract))) {
    return 'That is one of the Linagee contracts. A name given to it would be locked there. To wrap a name, use Wrap.'
  }
  return null
}

/** @param {string} label @param {string} key @param {string | bigint} tokenId @returns {Step} */
const unwrapStep = (label, key, tokenId) => ({
  id: 'unwrap', kind: 'unwrap', title: 'Unwrap the name', contract: WRAPPER_NAME, call: `unwrap(${tokenId})`, gas: GAS.unwrap, tx: unwrapTx(tokenId), tokenId: String(tokenId),
  detail: 'Burns the token and gives the name back to your address in the registry. If it is wrapped again, the token has a new number.'
})

/** @param {string} label @param {string} key @returns {Step} */
const unsetControllerStep = (label, key) => ({
  id: 'unsetController', kind: 'unsetController', title: 'Remove the controller', contract: RESOLVER_NAME, call: `unsetController(${label})`, gas: GAS.unsetController,
  tx: unsetControllerTx(key), detail: 'Afterwards only the holder can write the name\'s records, and nobody who held it before can.'
})

/** @param {string} label @param {string} key @param {string} textKey @returns {Step} */
const unsetRecordStep = (label, key, textKey) => ({
  id: `unsetRecord:${textKey}`, kind: 'unsetRecord', title: 'Clear a record', contract: RESOLVER_NAME, call: `unsetTextRecord(${label}, ${textKey})`, gas: GAS.unsetRecord,
  tx: unsetTextTx(key, textKey), textKey, detail: `Empties ${textKey}. The resolver then has no value for it.`
})

/** @param {string} label @param {string} key @returns {Step} */
const setPrimaryStep = (label, key) => ({
  id: 'setPrimary', kind: 'setPrimary', title: 'Make it your primary name', contract: RESOLVER_NAME, call: `setPrimary(${label})`, gas: GAS.setPrimary, tx: setPrimaryTx(key),
  detail: 'Marks the name as the one your address stands for. An address has one primary name, so this replaces the one it has now.'
})

/** @param {string} label @param {string} key @returns {Step} */
const unsetPrimaryStep = (label, key) => ({
  id: 'unsetPrimary', kind: 'unsetPrimary', title: 'End your primary name', contract: RESOLVER_NAME, call: 'unsetPrimary()', gas: GAS.unsetPrimary, tx: unsetPrimaryTx(),
  detail: `Stops ${label}.og standing for your address. Without it, the resolver would keep saying the name is yours after you gave it away.`
})

/** @param {string} label @param {string} key @param {string} to @returns {Step} */
const giveNameStep = (label, key, to) => ({
  id: 'giveName', kind: 'giveName', title: 'Give the name to the new holder', contract: REGISTRY_NAME, call: `transfer(${label}, ${shortAddress(to)})`, gas: GAS.giveName,
  tx: transferTx(key, to), to, detail: 'The registry hands the name over at once and cannot take it back. Only the new holder can give it away again.'
})

/** @param {string} label @param {string} account @param {string} to @param {string | bigint} tokenId @returns {Step} */
const sendTokenStep = (label, account, to, tokenId) => ({
  id: 'sendToken', kind: 'sendToken', title: 'Send the token to the new holder', contract: WRAPPER_NAME, call: `safeTransferFrom(you, ${shortAddress(to)}, ${tokenId})`, gas: GAS.sendToken,
  tx: sendTokenTx(account, to, tokenId), to, tokenId: String(tokenId),
  detail: `Whoever holds the token holds ${label}.og. The wrapper refuses a receiver that cannot hold tokens, and nothing is lost then.`
})

/**
 * The steps that hand a name this account holds in the registry to the wrapper and wrap it.
 * @param {string} label @param {string} key @param {string} account
 * @param {string | null} controller the name's controller when the steps start
 * @param {'self' | 'none'} target who the controller is to be when they end
 * @returns {Step[]}
 */
function rewrapSteps (label, key, account, controller, target) {
  /** @type {Step[]} */
  const steps = []
  if (target === 'self' && !is(controller, account)) steps.push(controllerStep(label, key, account, true))
  if (target === 'none' && !(controller !== null && is(controller, ZERO_ADDRESS))) steps.push(unsetControllerStep(label, key))
  steps.push(createWrapperStep(label, key), handOverStep(label, key), wrapStep(label, key, false))
  return steps
}

/** @param {string} name */
const needsController = (name) => `${name} is wrapped, so only its controller can write its records, and your address is not the controller. Fix the controller first.`

/**
 * @param {ManageRequest} request
 * @param {Facts} facts the name and the account's primary name, as `readFacts` reads them with the account
 * @returns {Plan} `problem` says why there is nothing to send, and `fix` the action that would put it right
 */
export function planManage (request, facts) {
  const { action, label, account } = request
  const { key } = facts
  const name = `${label}.og`
  const situation = situationOf(facts, account)
  const self = is(facts.controller, account)
  const none = facts.controller !== null && is(facts.controller, ZERO_ADDRESS)
  const mine = situation === 'mine'
  const wrapped = situation === 'wrappedMine'
  const canWrite = mine || self
  const present = (/** @type {string} */ textKey) => (facts.values[textKey] ?? '') !== ''
  /** @param {Step[]} steps @param {string[]} [notes] @returns {Plan} */
  const plan = (steps, notes = []) => ({ situation, steps, notes, problem: null, fix: null })
  /** @param {string} problem @param {Action | null} [fix] @returns {Plan} */
  const no = (problem, fix = null) => ({ situation, steps: [], notes: [], problem, fix })
  /** The records that counted, written again after the name changes hands, which would otherwise drop them. @returns {Step[]} */
  const keepSteps = () => (request.keep ?? []).filter((one) => facts.values[one.key] === one.text).map((one) => recordStep(label, key, one.key, one.text, {
    title: 'Write a record again',
    detail: `Keeps ${one.key} working: a record counts only if it was written after the name last changed hands.`,
    rewrite: true
  }))

  if (situation === 'free') return no(`${name} is not registered.`)
  if (situation === 'taken') return no(`${name} is held by another account, not by your address.`)
  const rewraps = action === 'wrap' || (request.rewrap === true && (action === 'fixController' || action === 'cleanUp'))
  if (situation === 'stranded') {
    if (!rewraps) return no(`The wrapper holds ${name} and has issued no token for it. Finish wrapping it first.`, 'wrap')
    return facts.wrapEnabled === true ? plan([wrapStep(label, key, true), ...(action === 'wrap' && self ? keepSteps() : [])]) : no(WRAP_OFF_WORDS)
  }

  if (action !== 'transfer' && action !== 'unwrap' && labelProblem(label) !== null) return no(`${name} is not in the standard spelling. ${SPELLING_WORDS}`)

  switch (action) {
    case 'setSite': {
      const contract = request.contract === undefined || request.contract === null ? [] : [{ key: CONTRACT_KEY, text: toChecksumAddress(request.contract) }]
      const records = [request.site ?? null, ...contract].filter((one) => one !== null)
      if (wrapped && !self) return no(needsController(name), 'fixController')
      if (records.length === 0) return no('Enter the address of the site first.')
      const steps = mine && !(self || none) ? [controllerStep(label, key, account, false)] : []
      for (const one of records) {
        steps.push(recordStep(label, key, one.key, one.text, one.key === CONTRACT_KEY
          ? { title: 'Set the web3:// address', detail: `Writes the contract ${name} is served from. Other interfaces read it, and Orivon opens it once it opens web3 records.` }
          : {}))
      }
      return plan(steps)
    }
    case 'reconfirm': {
      const wanted = (request.keys ?? []).filter(present)
      if (wanted.length === 0) return no('There is no record to confirm again.')
      if (wrapped && !self) return no(needsController(name), 'fixController')
      const steps = mine && !(self || none) ? [controllerStep(label, key, account, false)] : []
      for (const textKey of wanted) {
        steps.push(recordStep(label, key, textKey, facts.values[textKey] ?? '', {
          title: 'Confirm a record again', detail: `Writes ${textKey} again as it is on the resolver now, so it counts as written after the last change.`,
          rewrite: true
        }))
      }
      return plan(steps)
    }
    case 'clear': {
      const wanted = (request.keys ?? []).filter(present)
      if (wanted.length === 0) return no('There is no record to clear.')
      if (!canWrite) return no(wrapped ? needsController(name) : `Your address cannot write the records of ${name}.`, wrapped ? 'fixController' : null)
      const steps = mine && !(self || none) ? [controllerStep(label, key, account, false)] : []
      return plan([...steps, ...wanted.map((textKey) => unsetRecordStep(label, key, textKey))])
    }
    case 'setPrimary': {
      if (!canWrite) return no(wrapped ? needsController(name) : `Your address cannot write the records of ${name}.`, wrapped ? 'fixController' : null)
      if (facts.primary === key.toLowerCase() && is(facts.resolvesTo ?? null, account)) return no(`${name} is already your primary name.`)
      const notes = []
      const before = facts.primary !== undefined && facts.primary !== null && facts.primary !== key.toLowerCase() ? labelOfKey(facts.primary) : null
      if (before !== null) notes.push(`This replaces your primary name, ${before}.og: an address has one.`)
      return plan([setPrimaryStep(label, key)], notes)
    }
    case 'fixController':
    case 'cleanUp': {
      const target = action === 'fixController' ? 'self' : 'none'
      if (wrapped && (target === 'self' ? self : none)) return no(target === 'self' ? 'Your address is already the controller of this wrapped name.' : 'This name has no controller already.')
      if (mine && !request.rewrap) {
        if (action === 'cleanUp') return no('Clean-up is for a wrapped name. For one in the registry, Transfer removes the controller as part of giving it away.')
        return self || none ? no('The controller of this name is fine: it is your address, or nobody.') : plan([controllerStep(label, key, account, false)])
      }
      if (facts.wrapEnabled !== true) return no(WRAP_OFF_WORDS)
      const tail = rewrapSteps(label, key, account, facts.controller, target)
      return plan(wrapped ? [unwrapStep(label, key, facts.nameToId), ...tail] : tail)
    }
    case 'wrap': {
      if (wrapped) return no(`${name} is wrapped already.`)
      if (facts.wrapEnabled !== true) return no(WRAP_OFF_WORDS)
      return plan([...rewrapSteps(label, key, account, facts.controller, 'self'), ...keepSteps()])
    }
    case 'unwrap': {
      if (!wrapped) return no(`${name} is not wrapped.`)
      return plan([unwrapStep(label, key, facts.nameToId), ...(self || none ? keepSteps() : [])])
    }
    case 'transfer': {
      const problem = transferProblem(request.to, account)
      if (problem !== null) return no(problem)
      const to = toChecksumAddress(String(request.to).trim())
      const primary = request.unsetPrimary === true && facts.primary === key.toLowerCase() ? [unsetPrimaryStep(label, key)] : []
      if (mine) return plan([...primary, ...(request.unsetController === true && !none ? [unsetControllerStep(label, key)] : []), giveNameStep(label, key, to)])
      return plan([...primary, sendTokenStep(label, account, to, facts.nameToId)], [
        'Its controller stays as it is until the new holder changes it, and Orivon shows no record of the name until then. For a name with no controller, use "Clean up" first.'
      ])
    }
    default: return no('That change is not one this page makes.')
  }
}
