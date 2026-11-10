// My IDs: the usernames the connected address holds now, each confirmed on chain, with their records and the way to
// end every sign-in made with them.

import { el, fill } from './dom.js'
import { listIds } from './ids-list.js'
import { PERMANENT_NOTES } from './me-model.js'
import { addressCode, button, notice, working } from './parts.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { addIdSection, coverageNotice, lapsedSection } from './view-known.js'
import { mountCard } from './view-me-card.js'

/** @typedef {import('./app.js').App} App */

/**
 * @param {HTMLElement} root
 * @param {App} app
 */
export function mountMe (root, app) {
  let alive = true
  /** What adding an ID by name just said; shown once, above the list the addition changed. */
  let added = ''
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
    fill(body, working('Waiting for your wallet to share your address…'))
    const address = app.session.address ?? await app.connect()
    if (!alive) return
    if (address === null) {
      fill(body, notice('warn', app.session.failure ?? 'Orivon ID needs your address to list your IDs.', button('Connect', { primary: true, onClick: () => { void load() } })))
      return
    }
    fill(body, working('Reading the registry for the IDs your address holds…'),
      el('p', { class: 'hint', text: 'This reads the registry’s recent activity from your own node and checks every ID on chain, including the ones this device remembers.' }))
    try {
      const found = await listIds(app, address)
      if (!alive) return
      await show(found, address)
    } catch (error) {
      if (!alive) return
      const found = reasonOfError(error)
      fill(body, notice('bad', REASONS[found.reason]?.words ?? 'The IDs could not be read.', button('Try again', { quiet: true, onClick: () => { void load() } })))
    }
  }

  /** @param {import('./ids-list.js').Found} found @param {string} address */
  async function show (found, address) {
    const { names } = found
    const sure = found.coverage.complete
    const holds = names.length === 1 ? '1 ID' : `${names.length} IDs`
    const holder = names.length === 0 ? (sure ? 'This address holds no IDs.' : 'This page found no IDs held by this address.') : `This address holds ${holds}.`
    const cards = names.map(() => el('div', { class: 'id-slot' }))
    const saidAdded = added
    added = ''
    fill(body,
      saidAdded === '' ? null : notice('ok', saidAdded),
      el('div', { class: 'holder' },
        el('p', { class: 'muted', text: holder }),
        addressCode(address)),
      names.length === 0
        ? notice('info', sure ? 'You do not hold an ID yet.' : 'No ID found yet.', el('p', {}, el('a', { href: '#/', text: 'Register one' }), ' to sign in to Web3sites with a username.'))
        : cards,
      coverageNotice(found.coverage),
      lapsedSection(app, address, found.lapsed),
      addIdSection(app, address, { listed: () => new Set(names.map((one) => one.label)), added: (_, words) => { added = words; return load() } }),
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
