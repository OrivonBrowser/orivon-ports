// One action of the page of a name, as a panel: what it does and which contracts it calls, the few fields it needs, what it would send
// and what that costs, and the button. The request comes from manage-model.js and is planned there; this file draws it.

import { el, fill } from './dom.js'
import { previewOf, requestOf } from './manage-model.js'
import { button, costRows, notice, stepList } from './parts.js'
import { costOf, SITE_WORDS } from './register-model.js'
import { FIX_LABELS } from './manage-words.js'
import { shortAddress } from './words.js'

/** @typedef {import('./manage-model.js').Inputs} Inputs */
/** @typedef {import('./manage-plan.js').Action} Action */

let counter = 0

/** What the account's controller is, said next to the transfer. @param {string | null} controller */
const controllerLine = (controller) => controller === null ? 'its controller could not be read' : `its controller is ${shortAddress(controller)}`

/**
 * @param {import('./app.js').App} app
 * @param {object} parts
 * @param {ReturnType<typeof import('./manage-model.js').menuOf>[number]} parts.item
 * @param {() => import('./search-model.js').NameView} parts.view the name as last read
 * @param {string} parts.account
 * @param {string} parts.label
 * @param {() => bigint | null} parts.price the fee per gas the node suggests, or null
 * @param {(request: import('./manage-plan.js').ManageRequest) => void} parts.onStart
 * @param {(action: Action) => void} parts.onFix opens the panel of the action that would put a refusal right
 * @param {boolean} parts.open
 */
export function actionPanel (app, parts) {
  const { item, account, label } = parts
  const id = `act${counter++}`
  const view = parts.view()
  const rows = view.rows
  const isPrimary = view.facts.primary !== null && view.facts.primary !== undefined && view.facts.primary.toLowerCase() === view.facts.key.toLowerCase()
  const wrapped = view.state === 'wrapped'
  const noController = view.facts.controller !== null && /^0x0{40}$/i.test(view.facts.controller)

  const site = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: `${id}-site`, autocomplete: 'off', spellcheck: 'false', placeholder: 'ipfs://…' }))
  const contract = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: `${id}-contract`, autocomplete: 'off', spellcheck: 'false', placeholder: '0x…' }))
  const to = /** @type {HTMLInputElement} */ (el('input', { type: 'text', id: `${id}-to`, autocomplete: 'off', spellcheck: 'false', placeholder: '0x…' }))
  const dropController = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `${id}-uc`, checked: !noController }))
  const dropPrimary = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `${id}-up`, checked: true }))
  const confirm = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id: `${id}-ok` }))
  const ticks = rows.map((row, index) => /** @type {HTMLInputElement} */ (el('input', {
    type: 'checkbox', id: `${id}-r${index}`, 'data-key': row.key, checked: item.action === 'reconfirm' ? (!row.counts || rows.every((one) => one.counts)) : !row.counts
  })))
  const review = el('div', { class: 'review', 'aria-live': 'polite' })
  const foot = el('div', { class: 'actions' })

  /** @returns {Inputs} */
  const read = () => ({
    site: site.value, contract: contract.value, to: to.value, unsetController: dropController.checked, unsetPrimary: dropPrimary.checked,
    keys: ticks.filter((tick) => tick.checked).map((tick) => tick.dataset['key'] ?? '')
  })

  /** @param {Action | null} fix */
  const fixButton = (fix) => fix === null ? null : button(FIX_LABELS[fix], { quiet: true, onClick: () => { parts.onFix(fix) } })

  const fields = () => {
    switch (item.action) {
      case 'setSite':
        return [
          el('div', { class: 'field' }, el('label', { for: `${id}-site`, text: 'Site' }), site, el('p', { class: 'hint', text: SITE_WORDS })),
          el('div', { class: 'field' }, el('label', { for: `${id}-contract`, text: 'web3:// contract (optional)' }), contract,
            el('p', { class: 'hint', text: 'The contract the site is served from, written as contentcontract. Orivon opens it as a web3:// site, and other interfaces read it.' }))
        ]
      case 'reconfirm':
      case 'clear':
        return [el('fieldset', {}, el('legend', { text: item.action === 'clear' ? 'Records to clear' : 'Records to write again' }),
          rows.map((row, index) => el('div', { class: 'choice' }, ticks[index], el('label', { for: `${id}-r${index}` }, row.label,
            el('span', { class: 'choice-words', text: ` ${row.counts ? 'counts now' : 'does not count'}` })))))]
      case 'transfer':
        return [
          el('div', { class: 'field' }, el('label', { for: `${id}-to`, text: 'Give it to this address' }), to,
            el('p', { class: 'hint', text: wrapped ? 'The token goes to this address, and with it the name.' : 'The registry hands the name to this address at once. It cannot be undone.' })),
          wrapped
            ? el('p', { class: 'hint', text: `The token carries the name's controller with it (${controllerLine(view.facts.controller)}). Clean up first to remove it.` })
            : el('div', { class: 'choice' }, dropController, el('label', { for: `${id}-uc` }, 'Remove the controller first',
              el('span', { class: 'choice-words', text: ` (one more transaction). ${noController ? 'It has none now.' : `Now ${controllerLine(view.facts.controller)}.`}` }))),
          isPrimary
            ? el('div', { class: 'choice' }, dropPrimary, el('label', { for: `${id}-up` }, 'End my primary name first',
              el('span', { class: 'choice-words', text: ' (one more transaction). Otherwise the resolver keeps saying this name is your address\'s.' })))
            : null,
          el('div', { class: 'choice' }, confirm, el('label', { for: `${id}-ok`, text: 'I checked the address: the name cannot be taken back.' }))
        ]
      default: return []
    }
  }

  function drawReview () {
    const { request, problem } = requestOf(item.action, read(), { view: parts.view(), account, label })
    const asked = item.action !== 'transfer' || to.value.trim() !== ''
    const plan = previewOf(request, parts.view())
    const ready = problem === null && plan.problem === null && plan.steps.length > 0 && (item.action !== 'transfer' || confirm.checked) && !app.busy()
    const cost = costOf(plan, parts.price())
    fill(review,
      // Records not ticked yet is where the person starts, not a mistake: a hint. Text typed wrong is an alert.
      problem === null ? null : item.action === 'setSite' ? el('p', { class: 'tip-problem', role: 'alert', text: problem }) : el('p', { class: 'hint', text: problem }),
      plan.problem !== null && problem === null && asked
        ? notice('warn', null, el('p', { text: plan.problem }), fixButton(plan.fix))
        : null,
      plan.notes.map((note) => notice('info', null, el('p', { text: note }))),
      plan.steps.length === 0
        ? null
        : [el('h3', { text: 'What will be sent' }), stepList(plan.steps.map((step) => ({ ...step, state: 'pending', hash: null }))),
            costRows(cost)])
    fill(foot, button(app.busy() ? 'Another series is running' : item.button, { primary: true, disabled: !ready, onClick: () => { if (ready) parts.onStart(request) } }),
      app.session.address === null ? el('span', { class: 'hint', text: 'Connect your wallet first.' }) : null)
  }

  const panel = el('details', { class: 'action', 'data-action': item.action, open: parts.open },
    el('summary', {}, el('span', { class: 'action-title', text: item.title }),
      item.attention === null ? null : el('span', { class: 'badge warn', text: 'Needs a look' })),
    el('div', { class: 'action-body' },
      el('p', { text: item.words }),
      el('p', { class: 'step-call' }, el('span', { text: 'Calls ' }), el('code', { text: item.calls })),
      item.attention === null ? null : el('p', { class: 'hint', text: item.attention }),
      fields(), review, foot))
  for (const node of [site, contract, to, dropController, dropPrimary, confirm, ...ticks]) node.addEventListener('input', drawReview)
  panel.addEventListener('toggle', drawReview)
  drawReview()
  return { node: panel, refresh: drawReview, isOpen: () => /** @type {HTMLDetailsElement} */ (panel).open }
}
