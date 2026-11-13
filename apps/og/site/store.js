// What this page remembers on this device, in the site's own storage: the unwrapped names a person added to their list (the chain has no
// list of them per account), and the Orivon ID usernames they typed for the badge. Nothing here is sent anywhere, and a store that cannot
// be read or written (a private window, blocked storage) keeps what it is given for the page's life and nothing more.

import { isAddress } from './sdk/abi.js'
import { isValidLabel } from './sdk/orivonid.js'
import { labelProblem } from './resolver/og-name.js'

const PREFIX = 'og-names:'
/** The most names remembered for one account: a list longer than this is not one a person added by hand. */
export const MAX_REMEMBERED = 200

/** @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void }} Storage */

const isOgLabel = (/** @type {string} */ label) => labelProblem(label) === null

/** @param {unknown} text @param {(label: string) => boolean} valid @returns {string[]} the labels in a stored value that pass `valid`, each once, and nothing else */
function labelsIn (text, valid = isOgLabel) {
  if (typeof text !== 'string') return []
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((one) => typeof one === 'string' && valid(one)))].slice(0, MAX_REMEMBERED)
  } catch {
    return []
  }
}

/**
 * @param {Storage | null} [storage] `localStorage`, or null for none
 */
export function createStore (storage = null) {
  /** @type {Map<string, string>} */
  const memory = new Map()
  /** @param {string} key */
  const read = (key) => {
    try {
      const stored = storage?.getItem(key) ?? null
      if (stored !== null) return stored
    } catch { /* storage can be blocked: the page's own copy answers */ }
    return memory.get(key) ?? null
  }
  /** @param {string} key @param {string[]} labels */
  const write = (key, labels) => {
    const text = JSON.stringify(labels)
    memory.set(key, text)
    try { storage?.setItem(key, text) } catch { /* kept for the page's life only */ }
  }
  /** @param {string} account */
  const accountKey = (account) => `${PREFIX}${isAddress(account) ? account.toLowerCase() : ''}`

  return {
    /** The names this device remembers for an account, oldest first. @param {string} account */
    names (account) { return isAddress(account) ? labelsIn(read(accountKey(account))) : [] },
    /** @param {string} account @param {string} label */
    remember (account, label) {
      if (!isAddress(account) || labelProblem(label) !== null) return
      const current = labelsIn(read(accountKey(account)))
      if (!current.includes(label)) write(accountKey(account), [...current, label].slice(-MAX_REMEMBERED))
    },
    /** @param {string} account @param {string} label */
    forget (account, label) {
      if (!isAddress(account)) return
      write(accountKey(account), labelsIn(read(accountKey(account))).filter((one) => one !== label))
    },
    /** The Orivon ID usernames typed for the badge, not tied to an account: each is checked on chain against the address in question. */
    idNames () { return labelsIn(read(`${PREFIX}id`), isValidLabel) },
    /** @param {string} label an Orivon ID label */
    rememberId (label) {
      if (!isValidLabel(label)) return
      const current = labelsIn(read(`${PREFIX}id`), isValidLabel)
      if (!current.includes(label)) write(`${PREFIX}id`, [...current, label].slice(-MAX_REMEMBERED))
    }
  }
}
