// The listing screens: for each board this node hosts, what it still misses of a directory of `bitsocialnet/lists`, and a request to
// be listed that the board's own key signs, shown in full before anything is sent and opened on GitHub as a prefilled issue. It
// asks the node through `handle.listing` (`node/worker/listing-api.js`) and reads the directories from GitHub's raw files, as the
// apps do. Two sections share it: `listing` for an app that has no way to ask for a listing (5chan: the requirements, the request
// and its GitHub address), and `listing-signature` for one that has its own link to GitHub's issue (seedit: only the signed request,
// to paste into that issue).

import { createBoardSection, failure } from './board-section.js'
import { h } from './dom.js'
import { directoriesOf, FAMILIES, issueUrl, LISTS_RAW, LISTS_REPO, requestOf } from './listing-links.js'
import { fixOf, unmetOf, wordsOf } from './listing-requirements.js'
import { termOf } from './terms.js'

/** The directories are asked for again after this long when GitHub did not answer; a board's record after this long when it was read. */
const RETRY_DIRECTORIES_MS = 60_000
const REREAD_MS = 30_000

const plural = (/** @type {number} */ count, /** @type {string} */ one, /** @type {string} */ many) => `${String(count)} ${count === 1 ? one : many}`

/**
 * @param {{ doc: Document, handle: any, app: { name: string, term?: string }, classes: Record<string, string>, now: () => number, state: Record<string, any>,
 *   fetch: typeof fetch, open: (url: string) => void, copy: (text: string) => Promise<void> }} context
 * @param {{ family: keyof typeof FAMILIES, name: string }} kind
 * `state` is what a test reads of the section: whether it is shown, the boards as the node last said them, the directories and the last error.
 */
function createListing ({ doc, handle, app, classes, now, state, fetch, open, copy }, { family, name }) {
  const full = family === '5chan'
  const term = termOf(app)
  const at = (/** @type {string} */ role) => classes[role] ?? ''
  /** @type {import('./listing-links.js').Directory[] | null} */
  let directories = null
  let directoriesError = ''
  let retryAt = 0

  /** @param {{ address: string, publicKey: string }} listed */
  function createCard (listed) {
    const { address } = listed
    /** @type {any} */
    let record = null
    let readAt = 0
    let selected = ''
    /** @type {{ title: string, body: string, url: string } | null} */
    let request = null
    let busy = false
    let labels = ''
    /** What the board missed of the chosen directory when the request on show was made. */
    let madeFor = ''
    let offered = true

    const select = h(doc, 'select', { class: at('input'), 'data-nd-input': 'directory', 'aria-label': full ? 'Directory' : 'Route', on: { change: () => { selected = select.value; invalidate(); draw() } } })
    const hint = h(doc, 'span', { class: at('hint') })
    const ownerInput = full ? h(doc, 'input', { class: at('input'), type: 'text', autocomplete: 'off', placeholder: 'your-name.bso', 'data-nd-input': 'owner', on: { input: () => { ownerError.textContent = ''; invalidate() } } }) : null
    const ownerError = h(doc, 'span', { class: at('fieldError'), role: 'alert', 'data-nd-error': 'owner' })
    const note = h(doc, 'p', { class: at('note') })
    const requirements = h(doc, 'ul', { class: at('requirements'), 'data-nd-requirements': '' })
    const message = h(doc, 'p', { class: at('formMessage'), role: 'status', 'data-nd-message': '' })
    const prepare = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'prepare', text: 'Prepare the request', on: { click: () => { send().catch(() => {}) } } })
    const actions = h(doc, 'div', { class: at('actions') }, prepare)
    const badge = h(doc, 'span', { class: at('badge'), 'data-nd-state': '', hidden: true })
    const previewTitle = h(doc, 'p', { class: at('preview'), 'data-nd-preview': 'title' })
    const previewBody = h(doc, 'pre', { class: at('preview'), 'data-nd-preview': 'body' })
    const signed = h(doc, 'dd', { 'data-nd-signature': '' })
    const openButton = full ? h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'open', text: 'Open on GitHub', on: { click: () => { openIssue() } } }) : null
    const copyButton = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'copy', text: 'Copy the text', on: { click: () => { copyBody().catch(() => {}) } } })
    const shown = h(doc, 'div', { class: at('request'), hidden: true, 'data-nd-request': '' },
      h(doc, 'p', { class: at('label'), text: 'What will be sent' }),
      h(doc, 'p', { class: at('note'), text: full ? 'This is the issue GitHub opens, word for word. Nothing is sent until you press "Submit new issue" on GitHub.' : "Paste this into the issue seedit's own link opens, under its text. Nothing is sent from this page." }),
      previewTitle, previewBody,
      h(doc, 'dl', { class: at('facts') }, h(doc, 'dt', { text: 'Signed with the key of' }), h(doc, 'dd', { text: listed.publicKey }), h(doc, 'dt', { text: 'Signature (base 64)' }), signed),
      h(doc, 'div', { class: at('actions') }, ...(openButton === null ? [] : [openButton]), copyButton))
    const field = (/** @type {string} */ id, /** @type {string} */ label, /** @type {any[]} */ ...inside) => h(doc, 'div', { class: at('field'), 'data-nd-field': id, 'data-nd-owner': address },
      h(doc, 'label', { class: at('label'), text: label }), h(doc, 'span', { class: at('control') }, ...inside))
    const form = h(doc, 'form', { class: at('form'), novalidate: true, 'data-nd-form': `listing:${address}`, on: { submit: (/** @type {any} */ event) => { event.preventDefault(); send().catch(() => {}) } } },
      field('directory', full ? 'Directory' : 'Route', select, hint),
      ...(ownerInput === null ? [] : [field('owner', 'Your name (optional)', ownerInput, h(doc, 'span', { class: at('hint'), text: `A .bso or .eth name, shown in the directory as the ${term.board}'s owner.` }), ownerError)]),
      note, ...(full ? [requirements] : []), message, actions)
    const root = h(doc, 'article', { class: at('board'), 'data-nd-listing': address }, h(doc, 'header', { class: at('boardHead') }, h(doc, 'h3', { class: at('address'), text: address }), badge), form, shown)

    const directory = () => directories?.find((one) => one.code === selected) ?? null
    const published = () => record !== null && record.published === true
    /** The requirements the board misses of the chosen directory, as a string to compare; none for an app that checks nothing. */
    const verdict = () => { const chosen = directory(); return !full || chosen === null || record === null ? '' : JSON.stringify(unmetOf(chosen.requirements, record).map((one) => one.type)) }

    function say (/** @type {string} */ text, /** @type {boolean} */ bad = false) { message.textContent = text; message.setAttribute('data-nd-failed', bad ? 'true' : 'false') }
    function invalidate () { request = null; shown.hidden = true; ownerError.textContent = ''; say('') }

    /** What a board would need of each directory, in the label that offers it. */
    function optionLabels () {
      return (directories ?? []).map((one) => {
        if (!full) return `s/${one.code} - ${one.title}`
        if (!published()) return one.title
        const missing = unmetOf(one.requirements, record).length
        return `${one.title} (${missing === 0 ? `this ${term.board} meets the requirements` : `this ${term.board} misses ${plural(missing, 'requirement', 'requirements')}`})`
      })
    }

    function drawOptions () {
      const next = optionLabels()
      const key = JSON.stringify([next, (directories ?? []).map((one) => one.code)])
      if (key === labels) return
      labels = key
      select.textContent = ''
      select.append(h(doc, 'option', { value: '', text: full ? 'Choose a directory' : 'Choose a route' }), ...(directories ?? []).map((one, index) => h(doc, 'option', { value: one.code, text: next[index] })))
      select.value = (directories ?? []).some((one) => one.code === selected) ? selected : ''
      if (select.value === '') selected = ''
    }

    function draw () {
      if (request !== null && verdict() !== madeFor) { invalidate(); say(`The ${term.board}'s record has changed since this request was made. Prepare it again.`) }
      drawOptions()
      select.disabled = directories === null
      const chosen = directory()
      const held = record === null || record.signable === true
      note.textContent = record === null ? '' : !held ? `This node does not hold this ${term.board}'s key (its owner holds it elsewhere), so it cannot sign a request for it.`
        : !published() ? `This ${term.board} has not published its record yet. Start it and wait a minute: this page checks again by itself.` : ''
      requirements.textContent = ''
      badge.hidden = true
      if (full && chosen !== null && published()) {
        const missing = unmetOf(chosen.requirements, record)
        for (const one of chosen.requirements) {
          const met = !missing.includes(one)
          requirements.append(h(doc, 'li', { class: at('requirement'), 'data-nd-requirement': one.type, 'data-nd-met': String(met), text: met ? `Met: ${wordsOf(one)}` : `Missing: ${wordsOf(one)} (set ${fixOf(one)} in the ${term.board}'s settings)` }))
        }
        badge.textContent = missing.length === 0 ? `Meets all ${String(chosen.requirements.length)}` : `Misses ${String(missing.length)} of ${String(chosen.requirements.length)}`
        badge.hidden = false
      }
      prepare.disabled = busy || chosen === null || !published()
      if (held !== offered) { offered = held; if (held) actions.append(prepare); else prepare.remove() }
      hint.textContent = directories === null ? 'The directories have not loaded yet.' : ''
    }

    /** Asks the node for the board's record when there is none, it is a while old, or the board had not published. */
    async function read () {
      if (record !== null && record.published === true && now() - readAt < REREAD_MS) return
      try { record = await handle.listing('board', { address }); readAt = now(); if (message.getAttribute('data-nd-failed') === 'true') say('') } catch (error) { say(`The ${term.board}'s record could not be read: ${failure(error).words}`, true) }
      draw()
    }

    async function send () {
      const chosen = directory()
      if (busy || chosen === null || !published()) return
      busy = true
      prepare.disabled = true
      ownerError.textContent = ''
      try {
        const owner = ownerInput === null ? '' : ownerInput.value.trim()
        const signedRequest = await handle.listing('sign', { address, file: chosen.file, ...(owner === '' ? {} : { owner }) })
        const made = requestOf({ family, directory: chosen, address, signed: signedRequest, unmet: unmetOf(chosen.requirements, record) })
        request = { ...made, url: issueUrl(made) }
        madeFor = verdict()
        previewTitle.textContent = made.title
        previewBody.textContent = made.body
        signed.textContent = signedRequest.signature
        shown.hidden = false
        say(full ? 'Ready. Open it on GitHub when you have read it.' : 'Ready. Copy it when you have read it.')
      } catch (error) {
        const { words } = failure(error)
        shown.hidden = true
        if (words.startsWith('owner ')) { ownerError.textContent = words; say('') } else say(words, true)
      } finally { busy = false; draw() }
    }

    function openIssue () {
      if (request === null || !request.url.startsWith(`${LISTS_REPO}/issues/new?`)) return
      open(request.url)
      say('GitHub opened in a new tab. Nothing is sent until you press "Submit new issue" there.')
    }

    async function copyBody () {
      if (request === null) return
      try { await copy(request.body); say(full ? 'Copied the text of the issue.' : 'Copied. Paste it into the issue.') } catch { say('Copying did not work: select the text above and copy it yourself.', true) }
    }

    draw()
    return { element: root, read, draw, publicKey: listed.publicKey }
  }

  /** Reads the directories once, and again after a minute when GitHub did not answer. */
  async function loadDirectories () {
    if (directories !== null || now() < retryAt) return
    try {
      const answer = await fetch(`${LISTS_RAW}${FAMILIES[family].defaults}`, { cache: 'no-cache' })
      if (!answer.ok) throw new Error(`GitHub answered ${String(answer.status)}`)
      const found = directoriesOf(family, await answer.json())
      if (found.length === 0) throw new Error('the file lists no directory')
      directories = found
      directoriesError = ''
      state['directories'] = found
    } catch (error) {
      directoriesError = `The directories could not be read: ${error instanceof Error ? error.message : String(error)}`
      retryAt = now() + RETRY_DIRECTORIES_MS
    }
  }

  return createBoardSection({
    doc, classes, state, name, term,
    title: full ? `Get a ${term.board} listed` : `Prove a ${term.board} is yours`,
    intro: full
      ? `5chan's home page lists a few ${term.boards} for each topic, chosen from a list kept on GitHub (bitsocialnet/lists). Pick a directory, see what your ${term.board} still needs, and prepare a request: a GitHub issue that asks to add it, signed with your ${term.board}'s key so the people who review it can check that you own the ${term.board}. Nothing is sent from this page. GitHub opens with the text filled in, and you press its button.`
      : `seedit's own "Propose a community" link opens a GitHub issue, which does not prove who sends it. Sign a request here with your ${term.board}'s key, and paste it into that issue, so the people who review it can check that you own the ${term.board}.`,
    emptyText: `This node hosts no ${term.boards} yet. Create one and it appears here.`,
    list: () => handle.listing('boards'),
    makeCard: createCard,
    prepare: loadDirectories,
    extraError: () => directoriesError
  })
}

/** The section for an app with no way to ask for a listing: offered when the app names `listing` and the handle can make a listing call. */
export const listing = {
  name: 'listing',
  feature: 'listing',
  /** @param {Parameters<typeof createListing>[0]} context */
  mount: (context) => (typeof context.handle?.listing === 'function' ? createListing(context, { family: '5chan', name: 'listing' }) : null)
}

/** The section for an app with its own link to GitHub's issue: only the signed request, to paste into it. */
export const listingSignature = {
  name: 'listing-signature',
  feature: 'listing-signature',
  /** @param {Parameters<typeof createListing>[0]} context */
  mount: (context) => (typeof context.handle?.listing === 'function' ? createListing(context, { family: 'seedit', name: 'listing-signature' }) : null)
}
