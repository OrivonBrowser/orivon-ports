// The seeding screen: a switch, the space seeding may use, the communities it keeps (those the app's account follows, and those a
// person added) with what each holds, and the last pass. It asks the node through `handle.seeding` (`node/worker/seeding-api.js`)
// and is not shown by a node that has none. The follow list itself is sent by `follow-sync.js`, not by this screen.

import { NOT_OFFERED, failure } from './board-section.js'
import { h } from './dom.js'
import { agoOf, bytesOf, SIZE_UNITS, splitSize, toBytes } from './format.js'
import { termOf } from './terms.js'

/** What a community's state says. */
const STATUS_WORDS = { off: 'Not seeding', hosted: 'Hosted by this node', starting: 'Starting', waiting: 'Waiting for its record', holding: 'Held', 'over-limit': 'Over the space limit', error: 'Could not be read' }

const WHOLE = /^\d+$/

/**
 * @param {{ doc: Document, handle: any, app: { name: string, term?: string }, classes: Record<string, string>, now: () => number, state: Record<string, any> }} context
 * `state` is what a test reads of the section: whether it is shown, the node's last answer, the last error.
 */
function createSeeding ({ doc, handle, app, classes, now, state }) {
  const at = (/** @type {string} */ role) => classes[role] ?? ''
  const term = termOf(app)
  const element = h(doc, 'section', { class: at('section'), hidden: true, 'data-nd-section': 'seeding' })
  const failed = h(doc, 'p', { class: at('error'), role: 'alert' })
  const switchLine = h(doc, 'dd', { 'data-nd-seeding': 'switch' })
  const toggle = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'toggle', on: { click: () => { flip().catch(() => {}) } } })
  const usedLine = h(doc, 'dd', { 'data-nd-seeding': 'used' })
  const lastLine = h(doc, 'dd', { 'data-nd-seeding': 'last-run' })
  const check = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'run', text: 'Check now', on: { click: () => { act('run', {}, 'Checking.').catch(() => {}) } } })
  const message = h(doc, 'p', { class: at('formMessage'), role: 'status', 'data-nd-message': '' })
  const limitInput = h(doc, 'input', { class: at('input'), type: 'text', inputmode: 'numeric', autocomplete: 'off', 'data-nd-input': 'limit', on: { input: () => { limitDirty = true; limitError.textContent = ''; say('') } } })
  const limitUnit = h(doc, 'select', { class: at('input'), 'data-nd-input': 'limit-unit', 'aria-label': 'Unit of size', on: { change: () => { limitDirty = true } } }, ...SIZE_UNITS.map((unit) => h(doc, 'option', { value: unit.name, text: unit.name })))
  const limitError = h(doc, 'span', { class: at('fieldError'), role: 'alert', 'data-nd-error': 'limit' })
  const limitSave = h(doc, 'button', { class: at('button'), type: 'submit', 'data-nd-action': 'save-limit', text: 'Save the limit' })
  const limitForm = h(doc, 'form', { class: at('form'), novalidate: true, 'data-nd-form': 'seeding-limit', on: { submit: (/** @type {any} */ event) => { event.preventDefault(); saveLimit().catch(() => {}) } } },
    h(doc, 'div', { class: at('field'), 'data-nd-field': 'limit' },
      h(doc, 'label', { class: at('label'), text: 'Use at most' }),
      h(doc, 'span', { class: at('control') }, limitInput, limitUnit),
      limitError),
    h(doc, 'div', { class: at('actions') }, limitSave))
  const addInput = h(doc, 'input', { class: at('input'), type: 'text', autocomplete: 'off', placeholder: 'your-name.bso', 'data-nd-input': 'address', on: { input: () => { addError.textContent = '' } } })
  const addError = h(doc, 'span', { class: at('fieldError'), role: 'alert', 'data-nd-error': 'address' })
  const addForm = h(doc, 'form', { class: at('form'), novalidate: true, 'data-nd-form': 'seeding-add', on: { submit: (/** @type {any} */ event) => { event.preventDefault(); addOne().catch(() => {}) } } },
    h(doc, 'div', { class: at('field'), 'data-nd-field': 'address' },
      h(doc, 'label', { class: at('label'), text: `Add a ${term.board} to seed` }),
      h(doc, 'span', { class: at('control') }, addInput),
      addError),
    h(doc, 'div', { class: at('actions') }, h(doc, 'button', { class: at('button'), type: 'submit', 'data-nd-action': 'add', text: `Add the ${term.board}` })))
  const empty = h(doc, 'p', { class: at('note'), text: `No ${term.board} to seed yet. The ${term.boards} you follow in ${app.name} appear here, and you can add one below.` })
  const list = h(doc, 'div', { class: at('list') })
  const ignoredTitle = h(doc, 'h3', { class: at('sectionTitle'), text: `${term.Boards} you took out`, hidden: true })
  const ignoredList = h(doc, 'div', { class: at('list'), 'data-nd-seeding': 'ignored' })
  let limitDirty = false
  let busy = false
  let gone = false
  let refreshing = false
  /** @type {Map<string, ReturnType<typeof createCard>>} */
  const cards = new Map()

  element.append(
    h(doc, 'h2', { class: at('sectionTitle'), text: `Seed the ${term.boards} you follow` }),
    h(doc, 'p', { class: at('note'), text: `Seeding keeps a copy of the newest content of the ${term.boards} you follow and serves it, so they stay available while their owner is offline. It is off until you turn it on and never uses more than the space you set. Turning it off frees what it kept. It works while ${app.name} is open: the node stops with the app.` }),
    failed,
    h(doc, 'dl', { class: at('facts') }, h(doc, 'dt', { text: 'Seeding' }), switchLine, h(doc, 'dt', { text: 'Space used' }), usedLine, h(doc, 'dt', { text: 'Last check' }), lastLine),
    h(doc, 'div', { class: at('actions') }, toggle, check),
    message, limitForm, empty, list, ignoredTitle, ignoredList, addForm)

  function say (/** @type {string} */ text, /** @type {boolean} */ bad = false) { message.textContent = text; message.setAttribute('data-nd-failed', bad ? 'true' : 'false') }

  /** @param {string} address */
  function createCard (address) {
    const badge = h(doc, 'span', { class: at('badge'), 'data-nd-state': '' })
    const holds = h(doc, 'dd', { 'data-nd-bytes': '' })
    const origin = h(doc, 'dd')
    const updated = h(doc, 'dd')
    const problem = h(doc, 'dd')
    const problemTerm = h(doc, 'dt', { text: 'Problem', hidden: true })
    const remove = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'remove', text: 'Take it out', on: { click: () => { act('remove', { address }, `Took ${address} out.`).catch(() => {}) } } })
    const root = h(doc, 'article', { class: at('board'), 'data-nd-seeded': address },
      h(doc, 'header', { class: at('boardHead') }, h(doc, 'h3', { class: at('address'), text: address }), badge, remove),
      h(doc, 'dl', { class: at('facts') }, h(doc, 'dt', { text: 'Holds' }), holds, h(doc, 'dt', { text: 'Source' }), origin, h(doc, 'dt', { text: 'Updated' }), updated, problemTerm, problem))
    problem.hidden = true
    return {
      element: root,
      /** @param {any} one a community as the node lists it */
      draw (one) {
        badge.textContent = STATUS_WORDS[/** @type {keyof typeof STATUS_WORDS} */ (one.status)] ?? one.status
        badge.setAttribute('data-nd-state', one.status)
        holds.textContent = one.pins === 0 ? 'Nothing yet' : `${bytesOf(one.bytes)} in ${String(one.pins)} ${one.pins === 1 ? 'file' : 'files'}`
        origin.textContent = one.origin === 'added' ? 'Added here' : `Followed in ${app.name}`
        updated.textContent = one.updatedAt === null ? 'Not yet' : agoOf(one.updatedAt, now())
        problemTerm.hidden = problem.hidden = one.error === null
        problem.textContent = one.error ?? ''
      }
    }
  }

  /** @param {string} address */
  function ignoredRow (address) {
    return h(doc, 'div', { class: at('boardHead'), 'data-nd-ignored': address },
      h(doc, 'span', { class: at('address'), text: address }),
      h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'add-back', text: 'Seed it again', on: { click: () => { act('add', { address }, `Seeding ${address} again.`).catch(() => {}) } } }))
  }

  /** @param {any} answer what the node says of seeding */
  function draw (answer) {
    state['seeding'] = answer
    switchLine.textContent = answer.enabled ? 'On' : 'Off'
    toggle.textContent = answer.enabled ? 'Turn seeding off' : 'Turn seeding on'
    usedLine.textContent = `${bytesOf(answer.usedBytes)} of ${bytesOf(answer.limitBytes)}`
    lastLine.textContent = answer.enabled && answer.working ? 'Checking now' : answer.lastRun === null ? (answer.enabled ? 'Not yet' : 'Seeding is off') : `${agoOf(answer.lastRun.at, now())}: ${String(answer.lastRun.holding)} of ${String(answer.lastRun.communities)} held`
    if (!limitDirty) { const { value, unit } = splitSize(answer.limitBytes); limitInput.value = value; limitUnit.value = unit }
    const seen = new Set()
    for (const one of answer.communities) {
      seen.add(one.address)
      let card = cards.get(one.address)
      if (card === undefined) { card = createCard(one.address); cards.set(one.address, card); list.append(card.element) }
      card.draw(one)
    }
    for (const [address, card] of cards) if (!seen.has(address)) { card.element.remove(); cards.delete(address) }
    empty.hidden = cards.size > 0
    ignoredList.textContent = ''
    for (const address of answer.ignored) ignoredList.append(ignoredRow(address))
    ignoredTitle.hidden = answer.ignored.length === 0
  }

  /** One call, with the buttons held until it answers; its answer is the new state. @param {string} call @param {Record<string, unknown>} body @param {string} done @param {(words: string) => void} [onRefused] */
  async function act (call, body, done, onRefused) {
    if (busy) return
    busy = true
    try {
      draw(await handle.seeding(call, body))
      failed.textContent = ''
      state['error'] = null
      say(done)
      return true
    } catch (error) {
      const { words } = failure(error)
      if (onRefused === undefined) say(words, true); else onRefused(words)
      return false
    } finally { busy = false }
  }

  const flip = () => act(state['seeding']?.enabled === true ? 'disable' : 'enable', {}, state['seeding']?.enabled === true ? 'Seeding is off. What it kept is being freed.' : 'Seeding is on.')

  async function saveLimit () {
    const text = limitInput.value.trim()
    if (!WHOLE.test(text) || Number(text) === 0) { limitError.textContent = 'Enter a whole number above 0.'; return }
    const done = await act('limit', { bytes: toBytes(text, limitUnit.value) }, 'Saved.', (words) => { limitError.textContent = /space limit/.test(words) ? 'Use a size from 1 MB to 1 TB.' : words })
    if (done === true) limitDirty = false
    if (done === true && state['seeding'] !== undefined) draw(state['seeding'])
  }

  async function addOne () {
    const address = addInput.value.trim()
    if (address === '') { addError.textContent = `Type the address of a ${term.board}.`; return }
    const done = await act('add', { address }, `Added ${address}.`, (words) => { addError.textContent = words })
    if (done === true) addInput.value = ''
  }

  /** Asks the node for its state and draws it. A node with no seeding hides the section for good. */
  async function refresh () {
    if (gone || refreshing || busy) return
    refreshing = true
    try {
      let answer
      try { answer = await handle.seeding('state') } catch (error) {
        const { words, status } = failure(error)
        if (status !== null && NOT_OFFERED.includes(status)) { gone = true; state['shown'] = false; element.hidden = true; return }
        failed.textContent = `Seeding could not be read: ${words}`
        state['error'] = failed.textContent
        state['shown'] = true
        element.hidden = false
        return
      }
      failed.textContent = ''
      state['error'] = null
      state['shown'] = true
      element.hidden = false
      draw(answer)
    } finally { refreshing = false }
  }

  return { element, refresh }
}

/** The section: offered when the app names `seeding` and the handle can make a seeding call. */
export const seeding = {
  name: 'seeding',
  feature: 'seeding',
  /** @param {Parameters<typeof createSeeding>[0]} context */
  mount: (context) => (typeof context.handle?.seeding === 'function' ? createSeeding(context) : null)
}
