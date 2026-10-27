// The dialog that adds or changes a service that can also keep a share online.

import * as engine from '../engine.js'
import { h, icon, replace } from '../dom.js'
import { openDialog, toast } from '../ui/dialog.js'
import { defaultServiceId, describeService, loadServices, saveServices, setDefaultService } from '../ui/services.js'

/** @typedef {import('../engine.js').Target} Target */

const KINDS = ['kubo', 'filebase', 'pinata', 'rpc']

/** The commands that let this page reach a person's own node from another browser. @param {string} origin */
function nodeSetupCommands (origin) {
  return [
    `ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["${origin}"]'`,
    'ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods \'["POST"]\''
  ]
}

/** @param {{ target?: Target, onSaved: () => void }} options */
export function openTargetDialog ({ target, onSaved }) {
  /** @type {string} */
  let kind = target?.kind ?? 'pinata'
  /** @type {Record<string, HTMLInputElement>} */
  let inputs = {}
  const fieldsHost = h('div', { class: 'fields' })
  const status = h('p', { class: 'form-status', role: 'status' })

  function renderFields () {
    const spec = engine.TARGET_KINDS[/** @type {'kubo'} */ (kind)]
    inputs = {}
    replace(fieldsHost,
      h('p', { class: 'muted' }, spec.blurb, spec.link ? [' ', h('a', { href: spec.link.href, target: '_blank', rel: 'noopener noreferrer' }, spec.link.text)] : null),
      spec.fields.map((field) => {
        const input = /** @type {HTMLInputElement} */ (h('input', {
          class: 'input', type: field.secret ? 'password' : 'text', placeholder: field.placeholder ?? '', autocomplete: 'off', spellcheck: 'false',
          value: target?.kind === kind ? target.values[field.name] ?? '' : field.value ?? ''
        }))
        inputs[field.name] = input
        return h('label', { class: 'field' }, h('span', { class: 'field-label' }, field.label, field.optional ? h('span', { class: 'muted' }, ' (optional)') : null), input)
      }),
      kind === 'kubo' && !engine.environment().orivon
        ? h('div', { class: 'field-help' }, 'Your node must let this page in. Run these once, then restart the node:', h('pre', { class: 'commands' }, nodeSetupCommands(location.origin).join('\n')))
        : null,
      h('p', { class: 'field-help' }, 'Keys are kept in this browser only, and sent to that service only.'))
  }

  const kinds = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Service' }, KINDS.map((id) => {
    const button = h('button', { type: 'button', role: 'radio', class: 'segment', 'aria-checked': String(id === kind) }, engine.TARGET_KINDS[/** @type {'kubo'} */ (id)].label)
    button.addEventListener('click', () => {
      kind = id
      for (const other of kinds.querySelectorAll('.segment')) other.setAttribute('aria-checked', String(other === button))
      replace(status)
      renderFields()
    })
    return button
  }))

  /** @returns {Target | null} */
  function collect () {
    /** @type {Record<string, string>} */
    const values = {}
    for (const field of engine.TARGET_KINDS[/** @type {'kubo'} */ (kind)].fields) {
      const value = inputs[field.name]?.value.trim() ?? ''
      if (value === '' && !field.optional) {
        status.className = 'form-status form-status-error'
        status.textContent = `Fill in “${field.label}”.`
        inputs[field.name]?.focus()
        return null
      }
      values[field.name] = value
    }
    return { id: target?.id ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: /** @type {'kubo'} */ (kind), values }
  }

  /** @param {Target} candidate */
  async function store (candidate) {
    const all = await loadServices()
    const next = all.some((t) => t.id === candidate.id) ? all.map((t) => t.id === candidate.id ? candidate : t) : [...all, candidate]
    await saveServices(next)
    if (next.length === 1 && (await defaultServiceId()) === null && !target) await setDefaultService(candidate.id)
    dialog.close()
    toast(`${describeService(candidate)} is set up`, { kind: 'success' })
    onSaved()
  }

  async function check () {
    const candidate = collect()
    if (candidate === null) return
    dialog.setBusy(true)
    status.className = 'form-status'
    status.textContent = `Checking ${describeService(candidate)}…`
    try {
      await engine.testTarget(candidate, { signal: new AbortController().signal })
    } catch (error) {
      dialog.setBusy(false)
      status.className = 'form-status form-status-error'
      status.textContent = `${error instanceof Error ? error.message : String(error)} Save anyway with “Save without checking”.`
      return
    }
    dialog.setBusy(false)
    await store(candidate)
  }

  renderFields()
  const dialog = openDialog({
    title: target ? 'Change this service' : 'Add a service',
    body: [kinds, fieldsHost, status],
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
      { label: 'Save without checking', kind: 'ghost', onClick: () => { const candidate = collect(); if (candidate !== null) void store(candidate) } },
      { label: 'Check and save', kind: 'primary', onClick: () => { void check() } }
    ]
  })
}
