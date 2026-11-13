// What a registration says to the person when it stops, in plain words: what happened, what was and was not sent, and what it cost.
// Pure.

import { RELAY_WORDS } from './relay.js'
import { formatEth, SAFE_REASON, SAFE_WAIT } from './words.js'

/** What the person can press after a stop, by the offer the flow names. */
export const OFFER_LABELS = Object.freeze({
  unwrapped: 'Keep it unwrapped',
  finishWrapping: 'Finish wrapping',
  retry: 'Continue',
  public: RELAY_WORDS.sendPublicly
})

/** @param {Record<string, any>} view */
export function costLine (view) {
  const { feeWei, tipWei } = view['costs']
  const sentAny = view['steps'].some((/** @type {Record<string, any>} */ step) => step['hash'] !== null)
  if (!sentAny) return 'Nothing was sent, so nothing was spent.'
  return `What was sent cost ${formatEth(feeWei)} in gas${tipWei > 0n ? `, and the tip of ${formatEth(tipWei)} was sent` : ', and no tip was sent'}.`
}

/** @param {Record<string, any>} view @param {string} state */
export function titles (view, state) {
  return view['steps'].filter((/** @type {Record<string, any>} */ step) => step['state'] === state).map((/** @type {Record<string, any>} */ step) => step['title'])
}

/**
 * @param {Record<string, any>} view a flow state in phase `stopped`
 * @returns {{ tone: 'bad' | 'warn', title: string, lines: string[] }}
 */
export function outcomeWords (view) {
  const outcome = view['outcome']
  const name = String(view['name'])
  const done = titles(view, 'done')
  const dropped = titles(view, 'dropped').concat(titles(view, 'failed'))
  const afterSend = outcome['at'] !== null && done.length > 0
  const progress = [
    done.length === 0 ? null : `Done: ${done.join(', ')}.`,
    dropped.length === 0 ? null : `Not sent: ${dropped.join(', ')}.`
  ].filter((line) => line !== null)
  const cost = costLine(view)
  switch (outcome['kind']) {
    case 'taken':
      return outcome['at'] === null
        ? { tone: 'bad', title: `${name} is taken.`, lines: ['Someone holds it already. Nothing was signed and nothing was sent.'] }
        : {
            tone: 'bad',
            title: `Someone else took ${name} first.`,
            lines: ['Your first step was mined, but the registry does nothing and says nothing when a name is already held, so the name is theirs.',
              'The rest of the series was not sent, and neither was the tip.', cost]
          }
    case 'wrapOff':
      return {
        tone: 'warn',
        title: 'Wrapping is switched off.',
        lines: ['The owner of the wrapper contract has switched wrapping off, so the name cannot become a token right now. Nothing is stuck.',
          done.length === 0 ? `${name} is still free.` : `${name} is yours in the registry, unwrapped.`,
          'You can keep it unwrapped, and wrap it later when wrapping is back on.', ...progress, cost]
      }
    case 'wrapOffLate':
      return {
        tone: 'warn',
        title: 'Wrapping was switched off on the way to the wrapper.',
        lines: [`The wrapper holds ${name} and is waiting for you to wrap it. Until wrapping is switched on again the name is stuck there: you hold no token, and you cannot use or move it.`,
          'Only the wrapper\'s owner can switch wrapping on again, and nothing says when. Then come back to this name and press "Finish wrapping".', ...progress, cost]
      }
    case 'unsafe':
      return { tone: 'warn', title: 'The chain did not show what the next step needs, so it was not sent.', lines: ['No step was sent that could leave the name stuck.', ...progress, cost] }
    case 'unexpected':
      return {
        tone: 'bad',
        title: 'A step was mined but did not do what it should.',
        lines: ['The series stopped there. The name is wherever the last step that worked left it: look it up to see.', ...progress, cost]
      }
    case 'declined':
      return { tone: 'warn', title: 'You declined, so nothing more was sent.', lines: [...progress, cost] }
    case 'wouldFail':
      return { tone: 'warn', title: 'Your node says the next step would fail, so it was not signed.', lines: [...progress, cost] }
    case 'reverted':
      return {
        tone: 'bad',
        title: 'A step was mined and failed.',
        lines: ['The series stopped there, so nothing after it was sent.', afterSend ? 'The steps before it stay as they are.' : '', ...progress, cost].filter((line) => line !== '')
      }
    case 'unknownOutcome':
      return {
        tone: 'warn',
        title: outcome['at'] === 'tip' ? 'It is not known whether your tip went out.' : 'It is not known whether the last step went out.',
        lines: [outcome['at'] === 'tip'
          ? 'It may still be mined. Continuing reads its transaction first and never sends a second tip while it is not known whether the first went out.'
          : 'It may still be mined. Wait a minute, then continue: the page reads the name again and sends only what is still missing.',
        ...(outcome['offer'] === 'public' ? ['The private relay did not answer, so it may have passed the transaction on. Sending publicly reads the name first, too.'] : []),
        ...progress, cost]
      }
    default:
      return outcome['offer'] === 'public'
        ? { tone: 'warn', title: 'The private relay did not take the transaction, so the series stopped.', lines: [RELAY_WORDS.failed, ...progress, cost] }
        : {
            tone: 'warn',
            title: 'The node or the wallet could not answer, so the series stopped.',
            lines: ['Nothing was sent by the step that stopped. Continue when it is back.', ...progress, cost]
          }
  }
}

/**
 * What a finished registration says. A site written by it opens in Orivon only once the resolver's block is as old as the write, so the
 * words say when. A registration with no site has nothing to open, and says nothing about it.
 * @param {Record<string, any>} view
 * @returns {{ title: string, lines: string[] }}
 */
export function doneWords (view) {
  const { feeWei, tipWei } = view['costs']
  const wroteSite = Array.isArray(view['steps']) && view['steps'].some((/** @type {Record<string, any>} */ step) => step['kind'] === 'record' && step['state'] === 'done')
  return {
    title: `${String(view['name'])} is registered. It cost ${formatEth(feeWei)} in gas${tipWei > 0n ? `, and you tipped ${formatEth(tipWei)}` : ''}.`,
    lines: wroteSite ? [`Orivon starts to open its site in ${SAFE_WAIT}. ${SAFE_REASON}`] : []
  }
}
