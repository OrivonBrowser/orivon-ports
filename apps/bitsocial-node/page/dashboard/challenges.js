// The challenges section: for each board the node hosts, the anti-spam challenges it asks of a poster in a person's words, and a draft the owner
// edits (add, change, remove and order the challenges, and who is let through) and applies in one step. The Worker reads the board's settings,
// replaces the challenges alone and writes the whole back, so every other setting stays as it was (`node/worker/board-challenges.js`). A board is
// read once, when its card is drawn; what is typed is kept across refreshes, and an apply refuses a board that changed since it was read.

import { changesOf, entriesOf, moveRow, newRow, newRule, removeRow, rowOf, titleOf } from './challenge-model.js'
import { PRESETS } from './challenge-presets.js'
import { buildRow } from './challenge-row.js'
import { asksOf, hostLine, inTerm, shortName } from './challenge-words.js'
import { h } from './dom.js'
import { failure, NOT_OFFERED } from './failure.js'
import { termOf } from './terms.js'

/**
 * @typedef {{ infos: Map<string, any>, why: Map<string, string>, challenges: any[], unavailable: any[] }} Installed what the node offers: by name, the reason a
 *   challenge was left out, and both lists in the order the node gave them
 */

/** @param {{ challenges: any[], unavailable: any[] }} answer @returns {Installed} */
const installedOf = (answer) => ({
  infos: new Map(answer.challenges.map((one) => [one.name, one])), why: new Map(answer.unavailable.map((one) => [one.name, one.reason])),
  challenges: answer.challenges, unavailable: answer.unavailable
})

/**
 * @param {{ doc: Document, handle: any, app: { name: string, term?: string }, classes: Record<string, string>, state: Record<string, any> }} context
 * `state` is what a test reads of the section: whether it is shown, the boards as the node last said them, the last error.
 */
function createChallenges ({ doc, handle, app, classes, state }) {
  const at = (/** @type {string} */ name) => classes[name] ?? ''
  const term = termOf(app)
  const element = h(doc, 'section', { class: at('section'), hidden: true, 'data-nd-section': 'challenges' })
  const failed = h(doc, 'p', { class: at('error'), role: 'alert' })
  const empty = h(doc, 'p', { class: at('note'), text: `This node hosts no ${term.boards} yet. Create one in ${app.name} and it appears here.` })
  const list = h(doc, 'div', { class: at('list') })
  /** @type {Map<string, ReturnType<typeof createCard>>} */
  const cards = new Map()
  /** @type {Installed | null} */
  let installed = null
  /** How the node reads Ethereum now, as its last answer said (null: it does not say): the host line of a challenge that reads Ethereum follows it. @type {import('./ethereum-words.js').Reads | null} */
  let reads = null
  let gone = false
  let running = false

  /** @param {string} address */
  function createCard (address) {
    const own = /** @type {Installed} */ (installed)
    /** @type {import('./challenge-model.js').Row[]} */
    let rows = []
    /** @type {import('./challenge-model.js').Row[]} */
    let base = []
    /** @type {any[]} */
    let original = []
    /** @type {string[]} */
    let kept = []
    /** @type {Record<string, import('./challenge-model.js').RowErrors & { row: string }>} */
    let errors = {}
    /** @type {Array<ReturnType<typeof buildRow>>} */
    let handles = []
    const open = new Set()
    let sequence = 0
    let busy = false
    let loaded = false
    let loading = false

    const badge = h(doc, 'span', { class: at('badge') })
    const loadFailure = h(doc, 'p', { class: at('error'), role: 'alert' })
    const keptLine = h(doc, 'p', { class: at('note'), 'data-nd-part': 'kept' })
    const emptyNote = h(doc, 'p', { class: at('note'), text: `This ${term.board} asks nothing of a poster: anyone can post.` })
    const rowsHost = h(doc, 'div', { class: at('list') })
    const presets = PRESETS.filter((one) => own.infos.has(one.name))
    const picker = h(doc, 'select', { id: `nd-add-${address}`, class: at('input'), 'data-nd-input': 'add' },
      h(doc, 'option', { value: '', text: 'Choose a challenge' }),
      presets.length > 0 && h(doc, 'optgroup', { label: 'Presets' }, ...presets.map((one) => h(doc, 'option', { value: one.name, text: one.title }))),
      h(doc, 'optgroup', { label: 'Installed challenges' },
        ...own.challenges.filter((one) => !presets.some((preset) => preset.name === one.name)).map((one) => h(doc, 'option', { value: one.name, text: shortName(one.name) })),
        ...own.unavailable.map((one) => h(doc, 'option', { value: one.name, disabled: true, text: `${shortName(one.name)} (not available here: ${one.reason})` }))))
    const addAsks = h(doc, 'span', { class: at('hint'), 'data-nd-part': 'add-asks' })
    const addHost = h(doc, 'span', { class: at('hint'), 'data-nd-part': 'add-host' })
    const addButton = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'add', text: 'Add', on: { click: () => { add() } } })
    const changesLabel = h(doc, 'p', { class: at('note'), text: `Applying changes the ${term.board} like this:` })
    const changesList = h(doc, 'ul', { class: at('changes'), 'data-nd-part': 'changes' })
    const message = h(doc, 'p', { class: at('formMessage'), role: 'status', 'data-nd-part': 'message' })
    const applyButton = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'apply', text: 'Apply', disabled: true, on: { click: () => { apply().catch(() => {}) } } })
    const discardButton = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'discard', text: 'Discard changes', disabled: true, on: { click: () => { discard() } } })
    const reloadButton = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'reload', text: 'Read it again', hidden: true, on: { click: () => { load().catch(() => {}) } } })
    const body = h(doc, 'div', { hidden: true },
      keptLine, emptyNote, rowsHost,
      h(doc, 'div', { class: at('field') }, h(doc, 'label', { class: at('label'), for: picker.id, text: 'Add a challenge' }), h(doc, 'span', { class: at('control') }, picker, addButton), addAsks, ' ', addHost),
      changesLabel, changesList, h(doc, 'div', { class: at('actions') }, applyButton, discardButton, reloadButton), message)
    const root = h(doc, 'article', { class: at('board'), 'data-nd-challenge-board': address },
      h(doc, 'header', { class: at('boardHead') }, h(doc, 'h3', { class: at('address'), text: address }), badge), loadFailure, body)

    /** What the challenge in the picker asks, and the host it reaches, before it is added. */
    function describePick () {
      const info = own.infos.get(picker.value)
      const host = hostLine(info, {}, reads)
      addAsks.textContent = info === undefined ? '' : inTerm(asksOf(info), term)
      addHost.textContent = host
      addHost.hidden = host === ''
    }
    picker.addEventListener('change', describePick)

    /** @param {string} text @param {boolean} [bad] */
    function say (text, bad = false) { message.textContent = text; message.setAttribute('data-nd-failed', bad ? 'true' : 'false') }

    /** What the last apply refused in a row: one object for a row's life, which the row's fields read and an apply that is refused fills in. @param {string} key */
    const errorsOf = (key) => (errors[key] ??= { options: {}, excludes: {}, row: '' })

    /** The lines of what an apply changes, whether there is anything to apply, and the words on each row. */
    function update () {
      const built = entriesOf(rows, own.infos)
      const lines = changesOf(base, rows, own.infos, term)
      const notes = built.dropped.map(({ key, count }) => `${count === 1 ? 'A rule' : `${String(count)} rules`} of ${titleOf(/** @type {any} */ (rows.find((row) => row.key === key)))} that only named a challenge that is gone ${count === 1 ? 'is' : 'are'} dropped.`)
      changesList.textContent = ''
      for (const line of [...lines, ...notes]) changesList.append(h(doc, 'li', { text: line }))
      changesLabel.hidden = lines.length + notes.length === 0
      const dirty = lines.length > 0 || JSON.stringify(rows) !== JSON.stringify(base)
      applyButton.disabled = busy || !dirty
      discardButton.disabled = busy || !dirty
      for (const one of handles) one.refresh()
    }

    /** Draws the rows again: after a change of their number or order, or of what is open or refused. */
    function render () {
      handles = rows.map((row) => buildRow({
        doc, classes, term, rows, row, info: own.infos.get(row.name ?? ''), why: own.why.get(row.name ?? ''), open: open.has(row.key), errors: errorsOf(row.key), reads: () => reads,
        changed: () => { say(''); update() }, action: (name, extra) => { act(row, name, extra) }
      }))
      rowsHost.textContent = ''
      rowsHost.append(...handles.map((one) => one.element))
      emptyNote.hidden = rows.length > 0
      keptLine.textContent = kept.length === 0 ? '' : `Everything else about this ${term.board} stays as it is: ${kept.join(', ')}.`
      keptLine.hidden = kept.length === 0
      update()
    }

    /** @param {{ challenges: any[], otherSettings: string[] }} answer what the node says the board holds */
    function adopt (answer) {
      original = answer.challenges
      kept = answer.otherSettings
      rows = original.map((entry, index) => rowOf(entry, `b${String(index)}`))
      base = structuredClone(rows)
      open.clear()
      errors = {}
      loaded = true
      loadFailure.textContent = ''
      reloadButton.hidden = true
      body.hidden = false
      render()
    }

    /** Reads the board; a draft is replaced by what the board holds. */
    async function load () {
      if (loading) return
      loading = true
      try { adopt(await handle.challenges('board', { address })); say('') } catch (error) {
        if (!loaded) loadFailure.textContent = `The challenges could not be read: ${failure(error).words}`
        else say(failure(error).words, true)
      } finally { loading = false }
    }

    /** @param {import('./challenge-model.js').Row} row @param {string} name @param {number} [extra] */
    function act (row, name, extra) {
      if (name === 'up') rows = moveRow(rows, row.key, -1)
      else if (name === 'down') rows = moveRow(rows, row.key, 1)
      else if (name === 'remove') { rows = removeRow(rows, row.key); open.delete(row.key); delete errors[row.key] }
      else if (name === 'edit') { if (open.has(row.key)) open.delete(row.key); else open.add(row.key); handles[rows.indexOf(row)]?.setOpen(open.has(row.key)); return }
      else if (name === 'add-rule') { row.excludes.push(newRule()); open.add(row.key) }
      else if (name === 'remove-rule') { row.excludes.splice(extra ?? 0, 1); delete errors[row.key] }
      say('')
      render()
    }

    function add () {
      const info = own.infos.get(picker.value)
      if (info === undefined) return
      const row = newRow(info, `n${String(++sequence)}`)
      rows = [...rows, row]
      open.add(row.key)
      picker.value = ''
      describePick()
      say('')
      render()
    }

    function discard () {
      rows = structuredClone(base)
      open.clear()
      errors = {}
      say('')
      render()
    }

    /**
     * Shows what an apply was refused for beside the fields, without drawing the rows again, so what is being typed keeps its place.
     * @param {string} words @param {Record<string, any>} found what was refused, by row
     */
    function refuse (words, found) {
      for (const mine of Object.values(errors)) {
        for (const option of Object.keys(mine.options)) delete mine.options[option]
        for (const fields of Object.values(mine.excludes)) for (const field of Object.keys(fields)) delete fields[field]
        mine.row = ''
      }
      for (const [key, one] of Object.entries(found)) {
        const mine = errorsOf(key)
        Object.assign(mine.options, one.options)
        for (const [index, fields] of Object.entries(one.excludes ?? {})) Object.assign((mine.excludes[Number(index)] ??= {}), fields)
        mine.row = one.row ?? ''
        open.add(key)
      }
      handles.forEach((one, place) => { one.showErrors(); if (found[/** @type {any} */ (rows[place]).key] !== undefined) one.setOpen(true) })
      say(words, true)
    }

    async function apply () {
      if (busy || !loaded) return
      const built = entriesOf(rows, own.infos)
      if (Object.keys(built.errors).length > 0) { refuse('Fix the fields marked below, then apply again.', built.errors); return }
      busy = true
      update()
      try {
        adopt(await handle.challenges('apply', { address, challenges: built.entries, expect: original }))
        say(`Applied. The ${term.board} now asks these challenges, in this order.`)
      } catch (error) {
        const { words, status } = failure(error)
        if (status === 409) { reloadButton.hidden = false; say(`${words} Read it again to see what it holds now: nothing was applied.`, true) } else {
          /** @type {Array<{ index: number, option: string | null, message: string }>} */
          const failures = Array.isArray(/** @type {any} */ (error)?.failures) ? /** @type {any} */ (error).failures : []
          /** @type {Record<string, any>} */
          const found = {}
          for (const one of failures) {
            const row = rows[one.index]
            if (row === undefined) continue
            const mine = (found[row.key] ??= { options: {}, excludes: {} })
            if (one.option !== null && own.infos.get(row.name ?? '')?.optionInputs?.some((/** @type {any} */ input) => input.option === one.option)) mine.options[one.option] = one.message
            else mine.row = one.message
          }
          refuse(words, found)
        }
      } finally { busy = false; update() }
    }

    return {
      element: root,
      get loaded () { return loaded },
      /** @param {any} next what the node says of the board */
      update (next) {
        badge.textContent = next.started === true ? 'Running' : 'Not running'
        badge.setAttribute('data-nd-state', next.started === true ? 'running' : 'off')
      },
      load,
      /** Says the host of every challenge again, as the node reads Ethereum now. */
      redraw () { describePick(); for (const one of handles) one.refresh() }
    }
  }

  element.append(
    h(doc, 'h2', { class: at('sectionTitle'), text: 'Challenges' }),
    h(doc, 'p', { class: at('note'), text: `A challenge is what a poster must pass before a publication is accepted. Choose which challenges each ${term.board} asks and in what order, and who is let through without being asked. Nothing changes on a ${term.board} until you apply.` }),
    failed, empty, list)

  /** Asks the node for the boards, and the installed challenges once, and draws a card for each board. A node with no such call hides the section for good. */
  async function refresh () {
    if (gone || running) return
    running = true
    try {
      /** @type {{ boards: any[], ethereum?: import('./ethereum-words.js').Reads }} */
      let answer
      try {
        answer = await handle.challenges('boards')
        installed ??= installedOf(await handle.challenges('list'))
      } catch (error) {
        const { words, status } = failure(error)
        if (status !== null && NOT_OFFERED.includes(status)) { gone = true; state['shown'] = false; element.hidden = true; return }
        state['error'] = words
        failed.textContent = `The ${term.boards} could not be read: ${words}`
        state['shown'] = true
        element.hidden = false
        return
      }
      state['error'] = null
      failed.textContent = ''
      state['shown'] = true
      element.hidden = false
      state['boards'] = answer.boards
      const next = typeof answer.ethereum?.path === 'string' ? answer.ethereum : null
      const moved = next?.path !== reads?.path || next?.why !== reads?.why
      reads = next
      state['ethereum'] = next
      const seen = new Set()
      for (const board of answer.boards) {
        seen.add(board.address)
        let card = cards.get(board.address)
        if (card === undefined) { card = createCard(board.address); cards.set(board.address, card); list.append(card.element) }
        card.update(board)
        if (!card.loaded) await card.load()
      }
      for (const [address, card] of cards) if (!seen.has(address)) { card.element.remove(); cards.delete(address) }
      if (moved) for (const card of cards.values()) if (card.loaded) card.redraw()
      empty.hidden = cards.size > 0
    } finally { running = false }
  }

  return { element, refresh }
}

/** The section: offered when the app names the feature and the handle can make a challenge call. */
export const challenges = {
  name: 'challenges',
  feature: 'challenges',
  /** @param {Parameters<typeof createChallenges>[0]} context */
  mount: (context) => (typeof context.handle?.challenges === 'function' ? createChallenges(context) : null)
}
