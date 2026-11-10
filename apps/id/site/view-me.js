// My IDs: the usernames the connected address holds now, each confirmed on chain, with their records and the way to
// end every sign-in made with them.

import { el, fill } from './dom.js'
import { PERMANENT_NOTES, readCache, writeCache } from './me-model.js'
import { addressCode, button, notice, working } from './parts.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { namesOf } from './sdk/orivonid.js'
import { mountCard } from './view-me-card.js'

/** @typedef {import('./app.js').App} App */

/**
 * @param {HTMLElement} root
 * @param {App} app
 */
export function mountMe (root, app) {
  let alive = true
  const body = el('div', { class: 'ids' })
  root.append(el('div', { class: 'page' },
    el('h1', { text: 'My IDs' }),
    el('p', { class: 'lede', text: 'The usernames your address holds, read from Ethereum just now. An ID is listed as able to sign in only when the chain agrees that it is yours.' }),
    body))

  async function load () {
    if (app.chain === null) {
      fill(body, notice('warn', 'No wallet found', el('p', { text: 'Open this page in Orivon, or in a browser with an Ethereum wallet extension.' })))
      return
    }
    const chain = app.chain
    fill(body, working('Waiting for your wallet to share your address…'))
    const address = app.session.address ?? await app.connect()
    if (!alive) return
    if (address === null) {
      fill(body, notice('warn', app.session.failure ?? 'Orivon ID needs your address to list your IDs.', button('Connect', { primary: true, onClick: () => { void load() } })))
      return
    }
    fill(body, working('Reading the registry for the IDs your address holds…'),
      el('p', { class: 'hint', text: 'The first visit reads the registry’s history from your own light client. Later visits read only what is new.' }))
    try {
      const { names, cache } = await namesOf(chain, address, { cache: readCache(app.store, address) })
      writeCache(app.store, address, cache)
      if (!alive) return
      await show(names, address)
    } catch (error) {
      if (!alive) return
      const found = reasonOfError(error)
      fill(body, notice('bad', REASONS[found.reason]?.words ?? 'The IDs could not be read.', button('Try again', { quiet: true, onClick: () => { void load() } })))
    }
  }

  /** @param {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }[]} names @param {string} address */
  async function show (names, address) {
    const cards = names.map(() => el('div', { class: 'id-slot' }))
    fill(body,
      el('div', { class: 'holder' },
        el('p', { class: 'muted', text: names.length === 0 ? 'This address holds no IDs.' : `This address holds ${names.length} ${names.length === 1 ? 'ID' : 'IDs'}.` }),
        addressCode(address)),
      names.length === 0
        ? notice('info', 'You do not hold an ID yet.', el('p', {}, el('a', { href: '#/', text: 'Register one' }), ' to sign in to Web3sites with a username.'))
        : cards,
      el('details', { class: 'good' },
        el('summary', { text: 'Good to know before you sign anything about an ID' }),
        el('ul', {}, PERMANENT_NOTES.map((line) => el('li', { text: line })))))
    const reads = names.map((one, index) => mountCard(/** @type {HTMLElement} */ (cards[index]), app, one, address))
    for (const read of reads) {
      if (!alive) return
      await read()
    }
  }

  void load()
  return { unmount () { alive = false } }
}
