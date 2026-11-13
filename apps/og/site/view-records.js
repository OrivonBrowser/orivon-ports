// The records of a name as a card: each with its value, whether it counts and why. Drawn the same on the search and on the page of one
// of the person's names.

import { el } from './dom.js'
import { notice } from './parts.js'
import { NOT_OPENED_WORDS } from './words.js'

/**
 * @param {import('./search-model.js').NameView | null} name
 * @param {{ title?: string }} [options]
 * @returns {import('./dom.js').Child}
 */
export function recordsNodes (name, options = {}) {
  if (name === null) return null
  return [
    name.refusal === null ? null : notice('warn', 'The records of this name cannot be vouched for right now.', el('p', { text: name.refusal })),
    name.rows.length === 0
      ? null
      : el('section', { class: 'records-card', 'aria-labelledby': 'records-title' },
        el('h2', { id: 'records-title', text: options.title ?? (name.state === 'reReserved' ? 'Left on the resolver' : 'Records') }),
        el('ul', { class: 'record-rows' }, name.rows.map((row) =>
          el('li', { class: 'record-row', 'data-counts': String(row.counts) },
            el('div', { class: 'record-head' }, el('strong', { text: row.label }), el('span', { class: `badge ${row.counts ? 'ok' : 'warn'}`, text: row.counts ? 'Counts' : 'Does not count' })),
            el('code', { class: 'hex', text: row.value }),
            row.counts
              ? el('details', { class: 'detail' }, el('summary', { text: 'Why it counts' }), el('p', { class: 'hint', text: row.words }))
              : el('p', { class: 'hint why', text: row.words }),
            row.opened ? null : el('p', { class: 'hint', text: NOT_OPENED_WORDS })))))
  ]
}
