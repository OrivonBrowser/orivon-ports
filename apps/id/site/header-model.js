// What the strip under the bar says about how Ethereum is read, from what the page actually has: Orivon and whether it
// let the page read, a wallet extension, or nothing. Only the first of those wears the shield. Pure, but for `watchReads`,
// which wraps the calls of the chain it is given.

import { ChainError } from './sdk/chain.js'

/** @typedef {'unknown' | 'allowed' | 'refused'} Reading what Orivon did with the page's read of Ethereum: not asked yet, let it, or did not */

/** Where a person changes the answer: Orivon asks again when every tab of the site has been closed and the site is opened again. */
export const ALLOW_READ_WORDS = 'To allow it, close every tab of this site and open it again: Orivon asks once more.'

const WORDS = Object.freeze({
  allowed: 'Ethereum is read through your own light client, inside Orivon.',
  unknown: 'Inside Orivon, Ethereum is read through your own light client once you allow it.',
  refused: `Orivon is not letting this page read Ethereum, so nothing can be shown here. ${ALLOW_READ_WORDS}`,
  extension: 'Ethereum is read through your wallet extension and the server it uses. Inside Orivon it is read through your own light client.',
  none: 'No wallet is available, so nothing can be read from Ethereum here.'
})

/**
 * @param {{ kind: 'orivon' | 'eip1193' | null, reading: Reading }} parts `kind` is the chain the page was given, `reading` what Orivon did with its read
 * @returns {{ tone: 'ok' | 'neutral' | 'warn', shield: boolean, words: string }} the shield stands for a read the person's own light client answers, and for nothing else
 */
export function stripOf ({ kind, reading }) {
  if (kind === 'orivon') {
    if (reading === 'allowed') return { tone: 'ok', shield: true, words: WORDS.allowed }
    if (reading === 'refused') return { tone: 'warn', shield: false, words: WORDS.refused }
    return { tone: 'neutral', shield: false, words: WORDS.unknown }
  }
  if (kind === 'eip1193') return { tone: 'neutral', shield: false, words: WORDS.extension }
  return { tone: 'warn', shield: false, words: WORDS.none }
}

/**
 * What the strip above a page says about a registration the page is not showing, or null when there is nothing to say. A name that was
 * only looked up is not a registration: a lookup that stopped (no DAI, a name taken, a read that failed) is told on the search page
 * and never here.
 * @param {Record<string, any>} state the registration state (register-flow.js)
 * @returns {{ tone: 'info' | 'warn', words: string } | null}
 */
export function bannerOf (state) {
  const phase = String(state['phase'])
  if (['idle', 'ready', 'done'].includes(phase) || (phase === 'checking' && state['what'] === 'name')) return null
  if (phase === 'failed') return state['during'] === 'checking' ? null : { tone: 'warn', words: 'A registration needs your attention.' }
  return { tone: 'info', words: `A registration of ${String(state['name'] ?? 'a name')} is in progress.` }
}

/** The calls of a chain that are answered by the light client, and so by the person's say-so. */
const READS = Object.freeze([
  'chainId', 'blockNumber', 'getBlock', 'call', 'getLogs', 'getCode', 'getTransactionCount', 'estimateGas', 'gasPrice',
  'maxPriorityFeePerGas', 'getTransactionReceipt'
])

/**
 * The same chain, noting after each read whether Orivon let it through (`allowed`) or answered that the person did not
 * allow it (`refused`). A read that fails for another reason, such as a slow node, changes nothing. The wallet's calls
 * are not watched: a refused address is another question, which the bar's account area answers.
 * @param {import('./sdk/chain.js').Chain} chain
 * @param {(reading: Reading) => void} onChange called when the reading differs from the one before
 * @returns {{ chain: import('./sdk/chain.js').Chain, reading: () => Reading }}
 */
export function watchReads (chain, onChange) {
  /** @type {Reading} */
  let reading = 'unknown'
  /** @param {Reading} next */
  const note = (next) => {
    if (next === reading) return
    reading = next
    onChange(next)
  }
  const watched = /** @type {Record<string, any>} */ ({ ...chain })
  for (const name of READS) {
    const call = /** @type {Record<string, any>} */ (chain)[name]
    if (typeof call !== 'function') continue
    watched[name] = async (/** @type {unknown[]} */ ...args) => {
      try {
        const answer = await call(...args)
        note('allowed')
        return answer
      } catch (error) {
        if (error instanceof ChainError && error.reason === 'declined') note('refused')
        throw error
      }
    }
  }
  return { chain: /** @type {import('./sdk/chain.js').Chain} */ (watched), reading: () => reading }
}
