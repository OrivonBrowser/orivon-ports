// The board manager's screens: each board the node hosts with its manager's state, last error and archived threads, a switch
// for the manager and the limits it works to, and the settings every board takes unless it sets its own. It asks the node
// through `handle.manager` (the control channel, `node/worker/manager-api.js`), and is not shown by a node that has none.

import { fieldOfError, fieldWords } from './board-form.js'
import { h } from './dom.js'
import { agoOf, inOf } from './format.js'
import { createSettingsForm } from './settings-form.js'
import { termOf } from './terms.js'

const STATE_WORDS = { off: 'Off', starting: 'Starting', running: 'Running', backoff: 'Trying again', stopping: 'Stopping' }
/** What the node answers when it has no board manager: a build without one, or a node from before there was one. */
const NOT_OFFERED = [403, 404, 503]

const plural = (/** @type {number} */ count, /** @type {string} */ one, /** @type {string} */ many) => `${String(count)} ${count === 1 ? one : many}`

/**
 * What happens to a thread past the board's limit: the community's `features.noArchive`, which a board owner sets in the app's own board
 * settings (the dashboard only shows it, and says where it is set). `null`: the node could not read it.
 * @param {boolean | null | undefined} noArchive @param {string} appName @param {import('./terms.js').Term} term the app's word for a board
 */
function pastLimitWords (noArchive, appName, term) {
  const where = `Set in ${appName}: open the ${term.board}, ${term.Board} Settings, and "noArchive" under "features".`
  if (noArchive === true) return `Deleted at once, because this ${term.board} has no archive; the delay for an archived thread does not apply. ${where}`
  if (noArchive === false) return `Archived, then deleted after the delay. ${where}`
  return `Not known: the node reads it from the ${term.board} while the ${term.board} runs. ${where}`
}

/** @param {unknown} error what a call threw: a refusal carries `status` @returns {{ words: string, refused: boolean }} */
function failure (error) {
  const message = error instanceof Error ? error.message : String(error)
  const status = /** @type {any} */ (error)?.status
  return { words: typeof status === 'number' ? message : `The node did not answer: ${message}`, refused: typeof status === 'number' }
}

/**
 * @param {{ doc: Document, handle: any, app: { name: string, term?: string }, classes: Record<string, string>, now: () => number, state: Record<string, any> }} context
 * `state` is what a test reads of the section: whether it is shown, the boards and defaults as the node last said them, the last error.
 */
function createBoardManager ({ doc, handle, app, classes, now, state }) {
  const at = (/** @type {string} */ name) => classes[name] ?? ''
  const term = termOf(app)
  const element = h(doc, 'section', { class: at('section'), hidden: true, 'data-nd-section': 'board-manager' })
  const failed = h(doc, 'p', { class: at('error'), role: 'alert' })
  const empty = h(doc, 'p', { class: at('note'), text: `This node hosts no ${term.boards} yet. Create one in ${app.name} and it appears here.` })
  const list = h(doc, 'div', { class: at('list') })
  /** @type {Map<string, ReturnType<typeof createCard>>} */
  const cards = new Map()
  let gone = false

  /** @param {string} address */
  function createCard (address) {
    /** @type {any} */
    let board = null
    let busy = false
    const form = createSettingsForm({ doc, classes, term, owner: address, onSubmit: () => { save().catch(() => {}) } })
    const badge = h(doc, 'span', { class: at('badge') })
    const toggle = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'toggle', on: { click: () => { flip().catch(() => {}) } } })
    const save$ = h(doc, 'button', { class: at('button'), type: 'submit', 'data-nd-action': 'save', text: 'Save settings' })
    form.actions.append(save$)
    const status = h(doc, 'dd')
    const hosting = h(doc, 'dd')
    const archived = h(doc, 'dd', { 'data-nd-archived': '' })
    const pastLimit = h(doc, 'dd', { 'data-nd-past-limit': '' })
    const errorLine = h(doc, 'dd')
    const errorTerm = h(doc, 'dt', { text: 'Last error', hidden: true })
    errorLine.hidden = true
    const facts = h(doc, 'dl', { class: at('facts') }, h(doc, 'dt', { text: 'Manager' }), status, h(doc, 'dt', { text: 'Hosting' }), hosting, h(doc, 'dt', { text: 'Past the limit' }), pastLimit, h(doc, 'dt', { text: 'Archived threads' }), archived, errorTerm, errorLine)
    const root = h(doc, 'article', { class: at('board'), 'data-nd-board': address },
      h(doc, 'header', { class: at('boardHead') }, h(doc, 'h3', { class: at('address'), text: address }), badge, toggle), facts, form.element)

    function busyNow (/** @type {boolean} */ value) { busy = value; toggle.disabled = value; save$.disabled = value }

    /** @param {any} next what the node says of the board */
    function update (next) {
      board = next
      badge.textContent = STATE_WORDS[/** @type {keyof typeof STATE_WORDS} */ (next.state)] ?? next.state
      badge.setAttribute('data-nd-state', next.state)
      status.textContent = next.state === 'running' && next.since != null ? `Running (started ${agoOf(next.since, now())})`
        : next.state === 'backoff' ? `Trying again ${next.nextAttemptAt == null ? 'soon' : inOf(next.nextAttemptAt, now())}, after ${plural(next.failures, 'failed start', 'failed starts')} in a row`
          : STATE_WORDS[/** @type {keyof typeof STATE_WORDS} */ (next.state)] ?? next.state
      hosting.textContent = next.hosted ? 'Hosted by this node' : `This node does not host this ${term.board} any more`
      archived.textContent = String(next.archivedThreads)
      pastLimit.textContent = pastLimitWords(next.noArchive, app.name, term)
      errorTerm.hidden = errorLine.hidden = next.lastError == null
      errorLine.textContent = next.lastError == null ? '' : `${next.lastError}${next.lastErrorAt == null ? '' : ` (${agoOf(next.lastErrorAt, now())})`}`
      toggle.textContent = next.enabled ? 'Turn manager off' : 'Turn manager on'
      form.fill(next.config, next.effective)
    }

    /** One call of the form, with the board's buttons held until it answers. @param {() => Promise<any>} call @param {string} done */
    async function run (call, done) {
      if (busy) return
      busyNow(true)
      try {
        const next = await call()
        state['boards'] = state['boards'].map((/** @type {any} */ one) => (one.address === address ? next : one))
        update(next)
        form.fill(next.config, next.effective, true)
        form.showErrors({})
        form.say(done)
      } catch (error) {
        const { words } = failure(error)
        const field = fieldOfError(words)
        if (field === null) form.say(words, true)
        else { form.showErrors({ [field]: fieldWords(words) }); form.say('') }
      } finally { busyNow(false) }
    }

    async function flip () {
      if (board?.enabled === true) return run(() => handle.manager('disable', { address }), 'The manager is off.')
      const { patch, errors } = form.changes()
      form.showErrors(errors)
      if (Object.keys(errors).length > 0) return
      return run(() => handle.manager('enable', { address, config: patch }), 'The manager is on.')
    }

    async function save () {
      const { patch, errors } = form.changes()
      form.showErrors(errors)
      if (Object.keys(errors).length > 0) return
      if (Object.keys(patch).length === 0) { form.say('Nothing to change.'); return }
      return run(() => handle.manager('config', { address, config: patch }), board?.enabled === true ? 'Saved. The manager starts again with the new limits.' : 'Saved.')
    }

    return { element: root, update }
  }

  const defaultsForm = createSettingsForm({ doc, classes, term, owner: 'defaults', onSubmit: () => { saveDefaults().catch(() => {}) } })
  const defaultsSave = h(doc, 'button', { class: at('button'), type: 'submit', 'data-nd-action': 'save-defaults', text: `Save settings for every ${term.board}` })
  defaultsForm.actions.append(defaultsSave)

  async function saveDefaults () {
    const { patch, errors } = defaultsForm.changes()
    defaultsForm.showErrors(errors)
    if (Object.keys(errors).length > 0) return
    if (Object.keys(patch).length === 0) { defaultsForm.say('Nothing to change.'); return }
    defaultsSave.disabled = true
    try {
      const next = await handle.manager('defaults/set', { defaults: patch })
      state['defaults'] = next
      defaultsForm.fill(next.set, next.effective, true)
      defaultsForm.showErrors({})
      defaultsForm.say('Saved. Running managers start again with the new settings.')
      await refresh()
    } catch (error) {
      const { words } = failure(error)
      const field = fieldOfError(words)
      if (field === null) defaultsForm.say(words, true)
      else { defaultsForm.showErrors({ [field]: fieldWords(words) }); defaultsForm.say('') }
    } finally { defaultsSave.disabled = false }
  }

  element.append(
    h(doc, 'h2', { class: at('sectionTitle'), text: `${term.Boards} on this node` }),
    h(doc, 'p', { class: at('note'), text: `The ${term.board} manager keeps a ${term.board} tidy as an imageboard does: it archives the oldest thread once the ${term.board} holds more than its limit, deletes archived threads after a delay, and stops a thread moving up the ${term.board} once it has enough replies.` }),
    failed, empty, list,
    h(doc, 'h2', { class: at('sectionTitle'), text: `Settings for every ${term.board}` }),
    h(doc, 'p', { class: at('note'), text: `A ${term.board} that sets its own value keeps it.` }),
    defaultsForm.element)

  /** Asks the node for the boards and the defaults, and draws them. A node that has no board manager hides the section for good. */
  async function refresh () {
    if (gone) return
    /** @type {{ boards: any[] }} */
    let answer
    try { answer = await handle.manager('boards') } catch (error) {
      const { words, refused } = failure(error)
      if (refused && NOT_OFFERED.includes(/** @type {any} */ (error).status)) { gone = true; state['shown'] = false; element.hidden = true; return }
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
    const seen = new Set()
    for (const board of answer.boards) {
      seen.add(board.address)
      let card = cards.get(board.address)
      if (card === undefined) { card = createCard(board.address); cards.set(board.address, card); list.append(card.element) }
      card.update(board)
    }
    for (const [address, card] of cards) if (!seen.has(address)) { card.element.remove(); cards.delete(address) }
    empty.hidden = cards.size > 0
    try {
      const defaults = await handle.manager('defaults')
      state['defaults'] = defaults
      defaultsForm.fill(defaults.set, defaults.effective)
    } catch { /* the defaults are asked again at the next refresh */ }
  }

  return { element, refresh }
}

/** The section: offered when the app names the feature and the handle can make a control call. */
export const boardManager = {
  name: 'board-manager',
  feature: 'board-manager',
  /** @param {Parameters<typeof createBoardManager>[0]} context */
  mount: (context) => (typeof context.handle?.manager === 'function' ? createBoardManager(context) : null)
}
