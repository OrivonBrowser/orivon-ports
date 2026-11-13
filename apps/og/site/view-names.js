// The list of the connected account's names: the wrapper's tokens it holds, the unwrapped names it added here or started on this page,
// and the names the contracts hint at. Each row is read from the chain and says whether the name is wrapped, whether its site counts
// and what needs a look. The chain keeps no list of unwrapped names per account, so the page says where each name in the list came from.

import { el, fill } from './dom.js'
import { nameArt } from './art.js'
import { chipsOf, rowOf } from './names-model.js'
import { button, connectNotice, noWalletNotice, notice, retryNotice, working } from './parts.js'
import { describeName } from './search-model.js'
import { manageHash } from './router.js'
import { mountBadge } from './view-badge.js'
import { readName, readThrough, SUFFIX } from './words.js'

/** @typedef {import('./app.js').App} App */

const LOOKUPS_AT_ONCE = 2

const ADD_WORDS = 'A name held in the registry without a token is on no list the chain keeps. ' +
  'Type it here: the page checks on chain that your address holds it, and remembers it on this device only.'

/** @param {number} count @param {string} one @param {string} many */
const plural = (count, one, many) => count === 1 ? one : many

const EMPTY_WORDS = 'This address holds no wrapped name, and none was added or started here. Search a name to register it, or add one you hold.'

/** @param {number} left @param {number} read */
const leftWords = (left, read) => `${left} more wrapped ${plural(left, 'name is', 'names are')} held and not listed here: the page reads ${read} at a time.`

/** @param {number} count */
const unreadableWords = (count) => `${count} held ${plural(count, 'token is', 'tokens are')} for a name whose spelling is not text, so this page cannot show it.`

const LIST_WORDS = 'Wrapped names come from the wrapper contract. Unwrapped ones are only those added here or started on this page, ' +
  'and the names the resolver and the registry list for your address; the chain keeps no list of the rest.'

const FROM_WORDS = Object.freeze({
  token: 'Wrapped: you hold its token.',
  added: 'Added on this device.',
  hint: 'Your address names it, as its primary name or in the registry.'
})

/**
 * @param {HTMLElement} root
 * @param {App} app
 */
export function mountNames (root, app) {
  /** @type {Awaited<ReturnType<App['loadNames']>> | null} */
  let loaded = null
  /** @type {string | null} */
  let failure = null
  let loading = false
  let gone = false
  /** @type {Map<string, { kind: 'reading' } | { kind: 'failed' } | { kind: 'read', view: import('./search-model.js').NameView }>} */
  const rows = new Map()
  /** @type {AbortController | null} */
  let pending = null
  let message = /** @type {import('./dom.js').Child} */ (null)
  let loadedFor = ''
  /** @type {ReturnType<typeof mountBadge> | null} */
  let badge = null
  let badgeFor = ''

  const input = /** @type {HTMLInputElement} */ (el('input', {
    type: 'text', id: 'add-name', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-describedby': 'add-words', placeholder: 'your-name'
  }))
  const addButton = /** @type {HTMLButtonElement} */ (button('Add it', { primary: true, type: 'submit' }))
  const addForm = el('form', { class: 'add-form', novalidate: true },
    el('label', { for: 'add-name', text: 'Add a name you hold' }),
    el('div', { class: 'name-field' }, input, el('span', { class: 'suffix', text: `.${SUFFIX}` }), addButton),
    el('details', { class: 'detail' }, el('summary', { text: 'Why add a name?' }), el('p', { class: 'hint', id: 'add-words', text: ADD_WORDS })))
  const messageHost = el('div', { 'aria-live': 'polite' })
  const badgeHost = el('div', { class: 'badge-host', hidden: true })
  const listHost = el('div', { class: 'names-list-host' })
  root.append(el('div', { class: 'page wide' },
    el('div', { class: 'page-head' },
      el('h1', { text: 'My names' }),
      el('p', { class: 'lede', text: `The .${SUFFIX} names your address holds, and which of their sites count.` })),
    el('div', { class: 'cols' },
      el('div', { class: 'col-main' }, listHost),
      el('div', { class: 'col-side' }, badgeHost, addForm, messageHost))))

  /** @param {string} label @param {'token' | 'added' | 'hint'} source @param {string} account */
  function rowNode (label, source, account) {
    const read = rows.get(label)
    const view = read?.kind === 'read' ? read.view : null
    const row = view === null ? null : rowOf({ view, account, primary: view.facts.primary ?? null })
    const wrapped = row === null ? source === 'token' : row.state === 'wrapped'
    const lost = row !== null && row.state === 'lost'
    return el('li', { class: 'name-row', 'data-state': row === null ? 'reading' : row.state },
      el('a', { class: 'name-art', href: manageHash(label), 'aria-label': `${label}.${SUFFIX}` }, nameArt({ label, wrapped }, { class: 'name-art-thumb' })),
      el('div', { class: 'name-info' },
        el('h3', {}, el('a', { href: manageHash(label), text: `${label}.${SUFFIX}` })),
        row === null || view === null
          ? (read?.kind === 'failed' ? el('p', { class: 'hint', text: 'Could not be read right now.' }) : working('Reading…'))
          : [el('ul', { class: 'chips' }, chipsOf(row, view).map((chip) => el('li', { class: `chip ${chip.tone}`, text: chip.text }))),
              lost ? el('p', { class: 'hint', text: view.headline }) : null,
              !lost && row.site.tone === 'warn' ? el('p', { class: 'hint', text: row.site.words }) : null,
              !lost && row.controller.words !== null ? el('p', { class: 'hint', text: row.controller.words }) : null],
        source === 'token' ? null : el('p', { class: 'hint from', text: FROM_WORDS[source] })),
      el('div', { class: 'name-actions' },
        lost ? null : el('a', { class: 'button primary', href: manageHash(label), text: row !== null && row.finish ? 'Finish wrapping' : 'Manage' }),
        source === 'added' && (lost || row?.state === 'held') ? button('Forget', { quiet: true, onClick: () => { app.forgetName(account, label); void load() } }) : null))
  }

  function draw () {
    if (gone) return
    if (app.chain === null) { fill(listHost, noWalletNotice()); addForm.hidden = true; return }
    const account = app.session.address
    if (account === null) {
      addForm.hidden = true
      fill(listHost, connectNotice({ asking: app.session.asking, connect: () => { void app.connect() } }, 'Connect your wallet to see your names.',
        `The page reads Ethereum through ${readThrough(app.kind)} and lists what your address holds.`))
      return
    }
    addForm.hidden = false
    fill(messageHost, message)
    if (failure !== null) { fill(listHost, retryNotice('Your names could not be read.', failure, () => { void load() })); return }
    if (loaded === null) { fill(listHost, working('Reading your names from Ethereum…')); return }
    const shown = loaded.listed.filter((one) => {
      const read = rows.get(one.label)
      return !(one.source === 'hint' && read?.kind === 'read' && rowOf({ view: read.view, account, primary: null }).state === 'lost')
    })
    fill(listHost,
      el('section', { 'aria-labelledby': 'names-title' },
        el('h2', { id: 'names-title', text: shown.length === 0 ? 'No names yet' : `${shown.length} ${shown.length === 1 ? 'name' : 'names'}` }),
        shown.length === 0
          ? el('div', { class: 'empty' }, el('p', { text: EMPTY_WORDS }), el('a', { class: 'button primary', href: '#/', text: 'Search a name' }))
          : el('ul', { class: 'name-rows' }, shown.map((one) => rowNode(one.label, one.source, account)))),
      loaded.left > 0 ? notice('info', null, el('p', { text: leftWords(loaded.left, loaded.tokens.length) })) : null,
      loaded.unreadable > 0 ? notice('info', null, el('p', { text: unreadableWords(loaded.unreadable) })) : null,
      el('details', { class: 'detail' }, el('summary', { text: 'How this list is made' }), el('p', { class: 'hint', text: LIST_WORDS })))
    if (badgeFor !== account) {
      badge?.destroy()
      badgeFor = account
      badge = mountBadge(badgeHost, app, { address: account, auto: true, mine: true })
    }
  }

  async function reads (/** @type {string} */ account, /** @type {AbortSignal} */ signal) {
    const queue = (loaded?.listed ?? []).map((one) => one.label)
    const lanes = Array.from({ length: Math.min(LOOKUPS_AT_ONCE, queue.length) }, async () => {
      while (queue.length > 0 && !signal.aborted) {
        const label = /** @type {string} */ (queue.shift())
        try {
          const found = await app.lookupName(label, signal, { account, keys: app.manageKeys })
          if (signal.aborted) return
          rows.set(label, { kind: 'read', view: describeName({ label, inspection: found.inspection, facts: found.facts, account, keys: app.manageKeys }) })
        } catch {
          if (signal.aborted) return
          rows.set(label, { kind: 'failed' })
        }
        draw()
      }
    })
    await Promise.all(lanes)
  }

  async function load () {
    const account = app.session.address
    if (app.chain === null || account === null || loading) return
    loading = true
    pending?.abort()
    const mine = new AbortController()
    pending = mine
    loadedFor = account
    failure = null
    rows.clear()
    draw()
    try {
      loaded = await app.loadNames(account)
      if (mine.signal.aborted) return
      draw()
      await reads(account, mine.signal)
    } catch (error) {
      if (mine.signal.aborted) return
      failure = error instanceof Error && 'reason' in error && error.reason === 'declined'
        ? 'Orivon did not let this page read Ethereum. Close every tab of this site and open it again to be asked once more.'
        : 'Your node did not answer. Check the connection and try again.'
      loaded = null
    } finally {
      loading = false
    }
    draw()
  }

  addForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const account = app.session.address
    const typed = readName(input.value)
    if (account === null) return
    if (typed.kind !== 'name') {
      message = notice('warn', typed.kind === 'problem' ? typed.words : 'Type the name first.')
      draw()
      return
    }
    addButton.disabled = true
    message = working('Checking on chain…')
    draw()
    void app.addName(typed.label, account).then((found) => {
      message = notice(found.kind === 'added' || found.kind === 'finish' || found.kind === 'listed' ? 'ok' : 'warn', found.words)
      if (found.kind === 'added' || found.kind === 'finish') input.value = ''
      loading = false
      void load()
    }, () => { message = notice('warn', 'Your node did not answer, so the name was not checked.') }).finally(() => { addButton.disabled = false; draw() })
  })

  const stopSession = app.onSession(() => {
    const account = app.session.address
    if (account !== null && account !== loadedFor) void load()
    else draw()
  })
  draw()
  void load()

  return { unmount () { gone = true; pending?.abort(); badge?.destroy(); stopSession() } }
}
