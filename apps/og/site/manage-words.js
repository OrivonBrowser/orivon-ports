// What a change to a name says to the person: what each action is, what it did and what to do next, and what a stopped series left.
// Pure. A stop the registration words cover (a declined wallet, a node that did not answer) is worded there.

import { costLine, outcomeWords, titles } from './register-words.js'
import { formatEth, SAFE_REASON, SAFE_WAIT, shortAddress } from './words.js'

/**
 * What each action is: its title, what it does, the button that runs it and the contract calls it makes, in words.
 * @param {import('./manage-plan.js').Action} action
 * @param {boolean} wrapped whether the person holds the wrapper's token
 * @returns {{ title: string, words: string, button: string, calls: string }}
 */
export function actionWords (action, wrapped) {
  switch (action) {
    case 'setSite':
      return {
        title: 'Set or change the site', button: 'Set the site', calls: 'Linagee resolver: setTextRecord',
        words: 'Point the name at an IPFS, Swarm or Arweave address. You can also give the contract of a web3:// site, which Orivon opens once it opens web3 records.'
      }
    case 'reconfirm':
      return {
        title: 'Confirm the records again', button: 'Confirm the records again', calls: 'Linagee resolver: setTextRecord',
        words: 'Writes each record again with the value it has now. A record counts only if it was written after the name last changed hands and after its controller last changed.'
      }
    case 'clear':
      return {
        title: 'Clear the records', button: 'Clear the records', calls: 'Linagee resolver: unsetTextRecord',
        words: 'Empties the records of the name, one transaction each. For records a previous holder left, so nothing they wrote can be opened through this name.'
      }
    case 'setPrimary':
      return {
        title: 'Make it your primary name', button: 'Make it my primary name', calls: 'Linagee resolver: setPrimary',
        words: 'The name your address stands for. An address has one primary name, so this replaces the one it has now.'
      }
    case 'fixController':
      return wrapped
        ? {
            title: 'Fix the controller', button: 'Fix the controller', calls: 'Wrapper: unwrap; Linagee resolver: setController; Wrapper: createWrapper, wrap',
            words: 'Only the registry\'s owner can change a controller, and the wrapper owns a wrapped name. ' +
              'So it is unwrapped, your address becomes its controller, and it is wrapped again. The token number changes.'
          }
        : {
            title: 'Fix the controller', button: 'Fix the controller', calls: 'Linagee resolver: setController',
            words: 'Makes your address the controller, so a controller a previous holder named can no longer write the records of this name.'
          }
    case 'cleanUp':
      return {
        title: 'Clean up before giving it away', button: 'Clean up first', calls: 'Wrapper: unwrap; Linagee resolver: unsetController; Wrapper: createWrapper, wrap',
        words: 'Optional. A token carries its controller with it, and the new holder cannot change it without unwrapping. This removes it first. The token number changes, so give it away after.'
      }
    case 'transfer':
      return wrapped
        ? {
            title: 'Give it away', button: 'Send the token', calls: 'Wrapper: safeTransferFrom',
            words: 'Sends the token, and with it the name. Its controller stays as it is until the new holder changes it, and Orivon shows no record of the name until then.'
          }
        : {
            title: 'Give it away', button: 'Give it away', calls: 'Linagee resolver: unsetController; Linagee registry: transfer',
            words: 'Hands the name to another address, which cannot be undone. You can remove the controller first, in its own transaction.'
          }
    case 'wrap':
      return {
        title: 'Wrap it', button: 'Wrap it', calls: 'Wrapper: createWrapper, wrap',
        words: 'The wrapper gives you a token (an NFT) for the name. Whoever holds the token holds the name, and can sell it. The records that count are written again after.'
      }
    default:
      return {
        title: 'Unwrap it', button: 'Unwrap it', calls: 'Wrapper: unwrap',
        words: 'Burns the token and puts the name in your registry again. A later wrap gives a token with a new number. The records that count are written again after.'
      }
  }
}

/** What the person can press after a refusal, by the action that would put it right. */
export const FIX_LABELS = Object.freeze({
  fixController: 'Fix the controller',
  wrap: 'Finish wrapping',
  setSite: 'Set the site',
  reconfirm: 'Confirm the records again',
  clear: 'Clear the records',
  setPrimary: 'Make it my primary name',
  cleanUp: 'Clean up before giving it away',
  transfer: 'Give it away',
  unwrap: 'Unwrap it'
})

/** What the list of actions says when the account has none to take on the name; the sentence under the chips says why. */
export const NO_ACTIONS_WORDS = 'Nothing is offered for this name from your address. What it says above is why.'

/**
 * The sentence under the chips of a name's page that says where the name stands: for a name this account does not hold, and for a name that
 * offers it nothing to do, where the chips alone do not say why (a name stuck in the wrapper, waiting for another address).
 * @param {{ view: { words: string }, holds: boolean, actions: number }} parts
 * @returns {string | null}
 */
export function standingWords ({ view, holds, actions }) {
  return !holds || actions === 0 ? view.words : null
}

/**
 * A stop of a change that the registration words would get wrong, worded for a name the person already holds.
 * @param {Record<string, any>} view a flow state in phase `stopped`
 * @returns {{ tone: 'bad' | 'warn', title: string, lines: string[] }}
 */
export function manageOutcomeWords (view) {
  const kind = view['outcome']['kind']
  const name = String(view['name'])
  const done = titles(view, 'done')
  const progress = done.length === 0 ? [] : [`Done: ${done.join(', ')}.`]
  const dropped = titles(view, 'dropped').concat(titles(view, 'failed'))
  const rest = dropped.length === 0 ? [] : [`Not sent: ${dropped.join(', ')}.`]
  const cost = costLine(view)
  if (kind === 'taken') {
    return {
      tone: 'bad',
      title: `${name} is not yours any more.`,
      lines: [done.length === 0 ? 'Nothing was signed and nothing was sent.' : 'The steps before this one stay as they are.',
        'Search for the name to see who holds it now.', ...progress, ...rest, cost]
    }
  }
  if (kind === 'wrapOff') {
    return {
      tone: 'warn',
      title: 'Wrapping is switched off.',
      lines: [`The owner of the wrapper contract has switched wrapping off, so ${name} cannot become a token right now. Nothing is stuck.`,
        done.length === 0 ? `${name} is as it was.` : `${name} is in your registry, unwrapped: it is yours, and the steps done so far stay.`,
        'Press the same action again once wrapping is back on.', ...progress, ...rest, cost]
    }
  }
  return outcomeWords(view)
}

/**
 * What a finished change says, and what the person does next.
 * @param {Record<string, any>} view a flow state in phase `done`
 * @returns {{ title: string, lines: string[] }}
 */
export function manageDoneWords (view) {
  const name = String(view['name'])
  const { feeWei } = view['costs']
  const facts = view['facts']
  const sent = view['steps'].some((/** @type {Record<string, any>} */ step) => step['hash'] !== null)
  const spent = sent ? `It cost ${formatEth(feeWei)} in gas.` : 'Nothing was sent, so nothing was spent.'
  const later = sent ? `Typing the name in Orivon's address bar shows this change in ${SAFE_WAIT}. ${SAFE_REASON}` : ''
  /** The lines of a change to the records: what it did, what it cost, and when Orivon shows it. @param {string} did */
  const recordLines = (did) => [did, spent, later].filter((line) => line !== '')
  const token = facts !== null && facts !== undefined ? String(facts['nameToId']) : ''
  const request = view['request']
  switch (view['action']) {
    case 'setSite':
      return { title: `The site of ${name} is set.`, lines: recordLines('The list of records on this page shows whether it counts. A site that does not count says why.') }
    case 'reconfirm':
      return { title: `The records of ${name} are confirmed again.`, lines: recordLines('Each was written again with the value it has now, so it counts as written after the last change.') }
    case 'clear':
      return { title: `The records of ${name} are cleared.`, lines: recordLines('The resolver has no value for them now, so nothing a previous holder wrote can be opened through this name.') }
    case 'setPrimary':
      return { title: `${name} is your primary name.`, lines: ['It replaced the primary name your address had. An address has one, and a name has one address.', spent] }
    case 'fixController':
      return {
        title: `Your address is the controller of ${name}.`,
        lines: [request?.rewrap === true ? `It is wrapped again, with a new token number: ${token}. The old token no longer exists.` : '',
          'Records written before the controller changed do not count until they are written again: use "Confirm the records again".', spent].filter((line) => line !== '')
      }
    case 'cleanUp':
      return {
        title: `${name} has no controller and is wrapped again.`,
        lines: [`Its token has a new number: ${token}. Now the token can be given away with no controller left behind.`,
          'Records written before do not count until written again, and while it is wrapped only a controller can write them.', spent]
      }
    case 'transfer':
      return {
        title: `${name} was given away.`,
        lines: [request?.to === undefined ? '' : `It is held by ${shortAddress(String(request.to))} now, and your address cannot change it any more.`, spent].filter((line) => line !== '')
      }
    case 'wrap':
      return {
        title: `${name} is wrapped.`,
        lines: [`Its token number is ${token}. Whoever holds the token holds the name.`,
          'A record counts only if it was written after the name last changed hands: the ones that counted before were written again.', spent]
      }
    default:
      return {
        title: `${name} is unwrapped.`,
        lines: ['It is in your registry again and the token is gone. Wrapping it again gives a token with a new number.',
          'A record counts only if it was written after the name last changed hands: the ones that counted before were written again.', spent]
      }
  }
}
