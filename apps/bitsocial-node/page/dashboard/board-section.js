// What the dashboard's per-board sections share: a section that draws one card for each board the node hosts, asks the node for the list at
// every refresh, hides itself for good when the node has no such calls, and keeps in `state` what a test reads of it.

import { h } from './dom.js'
import { BOARD } from './terms.js'

/** What the node answers when it has none of a section's calls: a build without them, or a node from before there were any. */
export const NOT_OFFERED = [403, 404, 503]

/** @param {unknown} error a call threw: a refusal carries `status` */
export function failure (error) {
  const message = error instanceof Error ? error.message : String(error)
  const status = /** @type {any} */ (error)?.status
  return { words: typeof status === 'number' ? message : `The node did not answer: ${message}`, status: typeof status === 'number' ? status : null }
}

/**
 * @typedef {{ address: string, name?: string | null, publicKey: string }} Listed a board the node hosts, as the node lists it
 * @typedef {{ element: any, read?: () => Promise<void>, draw: (listed: Listed) => void }} Card
 */

/**
 * @param {{
 *   doc: Document, classes: Record<string, string>, state: Record<string, any>, name: string, term?: import('./terms.js').Term, title: string, intro: string, emptyText: string,
 *   list: () => Promise<{ boards: Listed[] }>, makeCard: (listed: Listed) => Card,
 *   prepare?: (boards: Listed[]) => Promise<void>, extraError?: () => string, notes?: any[]
 * }} options `list` asks the node for its boards (a refusal as a node with no such calls hides the section); `prepare` runs once the boards are
 *   known and there is at least one; `extraError` is what the section says when the node's list is fine and something else failed; `notes` are elements the section
 *   keeps under its introduction, which the caller draws
 */
export function createBoardSection ({ doc, classes, state, name, term = BOARD, title, intro, emptyText, list: listBoards, makeCard, prepare, extraError = () => '', notes = [] }) {
  const at = (/** @type {string} */ role) => classes[role] ?? ''
  const element = h(doc, 'section', { class: at('section'), hidden: true, 'data-nd-section': name })
  const failed = h(doc, 'p', { class: at('error'), role: 'alert' })
  const empty = h(doc, 'p', { class: at('note'), text: emptyText })
  const list = h(doc, 'div', { class: at('list') })
  /** @type {Map<string, Card>} */
  const cards = new Map()
  let boardsError = ''
  let gone = false
  let refreshing = false

  element.append(h(doc, 'h2', { class: at('sectionTitle'), text: title }), h(doc, 'p', { class: at('note'), text: intro }), ...notes, failed, empty, list)

  const drawError = () => { failed.textContent = boardsError !== '' ? boardsError : extraError(); state['error'] = failed.textContent === '' ? null : failed.textContent }

  /** Asks the node for its boards and draws a card for each. A node with none of the calls hides the section for good. */
  async function refresh () {
    if (gone || refreshing) return
    refreshing = true
    try {
      /** @type {{ boards: Listed[] }} */
      let answer
      try { answer = await listBoards() } catch (error) {
        const { words, status } = failure(error)
        if (status !== null && NOT_OFFERED.includes(status)) { gone = true; state['shown'] = false; element.hidden = true; return }
        boardsError = `The ${term.boards} could not be read: ${words}`
        drawError()
        state['shown'] = true
        element.hidden = false
        return
      }
      boardsError = ''
      state['shown'] = true
      element.hidden = false
      state['boards'] = answer.boards
      if (answer.boards.length > 0 && prepare !== undefined) await prepare(answer.boards)
      drawError()
      const seen = new Set()
      for (const listed of answer.boards) {
        seen.add(listed.address)
        let card = cards.get(listed.address)
        if (card === undefined) { card = makeCard(listed); cards.set(listed.address, card); list.append(card.element) }
        await card.read?.()
        card.draw(listed)
      }
      for (const [address, card] of cards) if (!seen.has(address)) { card.element.remove(); cards.delete(address) }
      empty.hidden = cards.size > 0
    } finally { refreshing = false }
  }

  return { element, refresh, drawError }
}
