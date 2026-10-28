// Settings: where Publish pins wikis, and the backups of the whole library.

import { h, icon, replace } from '../dom.js'
import { confirmDialog, downloadFile, openDialog, toast } from '../ui/dialog.js'
import { freePinningOn, hostingOn } from '../publish/page-node.js'
import { FREE, FREE_DAYS, KINDS, check, defaultTargetId, describe, loadTargets, nodeSetupCommands, saveTargets, setDefaultTarget } from '../publish/targets.js'
import { backup, newId } from '../wikis.js'
import { addressesPanel } from './addresses.js'
import { hostingSwitches } from './hosting-switches.js'

/** @typedef {import('../publish/targets.js').Target} Target */

/** @param {unknown} error */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The dialog that adds or changes a publishing service.
 * @param {{ target?: Target, onSaved: () => void }} options
 */
export function openTargetDialog ({ target, onSaved }) {
  /** @type {keyof typeof KINDS} */
  let kind = target?.kind ?? 'pinata'
  /** @type {Record<string, HTMLInputElement>} */
  let inputs = {}
  const fieldsHost = h('div', { class: 'fields' })
  const status = h('p', { class: 'form-status', role: 'status' })

  function renderFields () {
    const spec = KINDS[kind]
    inputs = {}
    replace(fieldsHost,
      h('p', { class: 'muted' }, spec.blurb, spec.link ? [' ', h('a', { href: spec.link.href, target: '_blank', rel: 'noopener noreferrer' }, spec.link.text)] : null),
      spec.fields.map((field) => {
        const input = /** @type {HTMLInputElement} */ (h('input', {
          class: 'input',
          type: field.secret ? 'password' : 'text',
          placeholder: field.placeholder ?? '',
          autocomplete: 'off',
          spellcheck: 'false',
          value: target?.kind === kind ? target.values[field.name] ?? '' : field.value ?? ''
        }))
        inputs[field.name] = input
        return h('label', { class: 'field' }, h('span', { class: 'field-label' }, field.label, field.optional ? h('span', { class: 'muted' }, ' (optional)') : null), input)
      }),
      kind === 'kubo'
        ? h('div', { class: 'field-help' }, 'Your node must let this editor in. Run these once, then restart the node:',
            h('pre', { class: 'commands' }, nodeSetupCommands(location.origin).join('\n')))
        : null,
      h('p', { class: 'field-help' }, icon('alert'), 'Keys are kept in this browser only, and sent to that service only.'))
  }

  const kinds = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Service' }, Object.entries(KINDS).map(([id, spec]) => {
    const button = h('button', { type: 'button', role: 'radio', class: 'segment', 'aria-checked': String(id === kind) }, spec.label)
    button.addEventListener('click', () => {
      kind = /** @type {keyof typeof KINDS} */ (id)
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
    for (const field of KINDS[kind].fields) {
      const value = inputs[field.name]?.value.trim() ?? ''
      if (value === '' && !field.optional) {
        status.className = 'form-status form-status-error'
        status.textContent = `Fill in “${field.label}”.`
        inputs[field.name]?.focus()
        return null
      }
      values[field.name] = value
    }
    return { id: target?.id ?? newId(), kind, values }
  }

  /** @param {boolean} save */
  async function test (save) {
    const candidate = collect()
    if (candidate === null) return
    dialog.setBusy(true)
    status.className = 'form-status'
    status.textContent = `Checking ${describe(candidate)}…`
    try {
      await check(candidate)
      status.className = 'form-status form-status-ok'
      status.textContent = `${describe(candidate)} answers, and accepts the key.`
    } catch (error) {
      dialog.setBusy(false)
      status.className = 'form-status form-status-error'
      status.textContent = messageOf(error)
      if (save) status.textContent += ' Save anyway with “Save without checking”.'
      return
    }
    dialog.setBusy(false)
    if (save) await store(candidate)
  }

  /** @param {Target} candidate */
  async function store (candidate) {
    const all = await loadTargets()
    const next = all.some((t) => t.id === candidate.id) ? all.map((t) => t.id === candidate.id ? candidate : t) : [...all, candidate]
    await saveTargets(next)
    if (next.length === 1 || await defaultTargetId() === null) await setDefaultTarget(candidate.id)
    dialog.close()
    toast(`${describe(candidate)} is set up`, { kind: 'success' })
    onSaved()
  }

  renderFields()
  const dialog = openDialog({
    title: target ? 'Change the publishing service' : 'Add a publishing service',
    body: [kinds, fieldsHost, status],
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
      { label: 'Save without checking', kind: 'ghost', onClick: () => { const c = collect(); if (c !== null) void store(c) } },
      { label: 'Check and save', kind: 'primary', onClick: () => { void test(true) } }
    ]
  })
}

/**
 * What Publish does with a wiki when the person has chosen nothing else, in words.
 * @param {boolean} hosted @param {boolean} free
 */
function defaultRoute (hosted, free) {
  if (hosted && free) return `your IPFS node, in this page, which Orivon keeps up for ${FREE_DAYS} days`
  if (hosted) return 'only this computer, while the editor is open'
  return free ? 'free pinning by Orivon' : ''
}

/** What free pinning keeps and sees, by the way a wiki reaches it. @param {boolean} fromNode */
function freeNote (fromNode) {
  return fromNode
    ? h('p', {}, `Free pinning: Orivon's node connects to your node, reads the wiki and keeps each version on IPFS for ${FREE_DAYS} days, once, on Orivon's Filebase account; a new version gets ${FREE_DAYS} days of its own. Orivon's node sees your IP address; Filebase sees only the wiki, which is public once published anyway. Orivon writes down the wiki's address and when it was pinned, never who sent it.`)
    : h('p', {}, `Free pinning keeps each version you publish with it on IPFS for ${FREE_DAYS} days, once; a new version gets ${FREE_DAYS} days of its own. It takes published DecentraWiki wikis only. The wiki goes to Orivon's server, which sees your IP address while it uploads, and from there to Orivon's Filebase account, which sees only the wiki: it is public once published anyway. The server writes down the wiki's address and when it was pinned, never who sent it.`)
}

/** @param {HTMLElement} view */
export async function renderSettings (view) {
  const targets = await loadTargets()
  const preferred = await defaultTargetId()
  const fromNode = await hostingOn()
  const freeOn = await freePinningOn()
  const refresh = () => { void renderSettings(view) }

  /** @param {Target} target */
  const row = (target) => {
    const status = h('span', { class: 'muted small' })
    return h('li', { class: 'target' },
      h('div', { class: 'target-main' },
        h('strong', {}, describe(target)),
        h('span', { class: 'muted small' }, target.id === preferred ? 'Used by default' : target.kind === 'free' ? '' : KINDS[target.kind].label),
        status),
      h('div', { class: 'row' },
        target.id === preferred ? null : h('button', { type: 'button', class: 'button button-ghost button-small', onclick: async () => { await setDefaultTarget(target.id); refresh() } }, 'Use by default'),
        h('button', { type: 'button', class: 'button button-ghost button-small', onclick: async () => {
          status.textContent = ' · Checking…'
          try {
            await check(target)
            status.textContent = ' · Answers, and accepts the key'
          } catch (error) {
            status.textContent = ` · ${messageOf(error)}`
          }
        } }, 'Check'),
        h('button', { type: 'button', class: 'button button-ghost button-small', onclick: () => openTargetDialog({ target, onSaved: refresh }) }, 'Change'),
        h('button', { type: 'button', class: 'icon-button', 'aria-label': `Remove ${describe(target)}`, onclick: async () => {
          if (!await confirmDialog({ title: `Remove ${describe(target)}?`, message: 'Its key is deleted from this browser. Wikis already pinned there stay pinned.', confirm: 'Remove', danger: true })) return
          const rest = (await loadTargets()).filter((t) => t.id !== target.id)
          await saveTargets(rest)
          if (preferred === target.id) await setDefaultTarget(rest[0]?.id ?? null)
          refresh()
        } }, icon('trash'))))
  }

  const addresses = await addressesPanel(refresh)
  replace(view, h('section', { class: 'settings' },
    h('h1', {}, 'Settings'),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', {}, h('h2', {}, 'Publishing'), h('p', { class: 'muted' }, 'Where Publish pins your wikis on IPFS. The editor computes every address itself and accepts a pin only when the service reports that same address.')),
        h('button', { type: 'button', class: 'button button-primary', onclick: () => openTargetDialog({ onSaved: refresh }) }, icon('plus'), 'Add a service')),
      targets.length === 0
        ? h('p', { class: 'empty' }, `No service of yours yet. Publish ${fromNode || freeOn ? `uses ${defaultRoute(fromNode, freeOn)}, or ` : ''}downloads a wiki as a CAR file for you to pin anywhere.`)
        : h('ul', { class: 'targets' }, targets.map(row)),
      await hostingSwitches(refresh),
      h('details', { class: 'explain' },
        h('summary', {}, 'Hosting, free pinning and kept addresses: what Orivon keeps, and what it sees'),
        fromNode ? h('p', {}, 'Hosting: this page runs an IPFS node, Orivon\'s own, under this editor\'s permissions. While the editor is open it serves the newest version of each wiki you published to anyone on IPFS, and it stops when the editor\'s last tab closes. It announces the wikis on the IPFS network, and when your router refuses connections it holds a place on Orivon\'s relay, so the nodes that look a wiki up, the people who open it and Orivon\'s relay see your IP address. It holds about 200 MiB of wikis in one run.') : null,
        freeOn ? freeNote(fromNode) : null,
        h('p', {}, `When you publish under an address of your wiki's, Orivon's node also keeps that address up for ${FREE_DAYS} days after each publish, whichever service pins the wiki. It reads the version and checks it is a DecentraWiki wiki first. The server writes down the address, its newest record, the version and the time, never who sent it.`),
        h('p', { class: 'muted small' }, 'Address: ', h('code', {}, FREE.values.endpoint ?? '')))),
    addresses,
    h('section', { class: 'panel' },
      h('h2', {}, 'Your data'),
      h('p', { class: 'muted' }, 'Every wiki lives in this browser only. A backup file holds them all, with their publications and the address each uses, but not the keys of those addresses; restore it with Import in the library.'),
      h('button', { type: 'button', class: 'button button-secondary', onclick: async () => {
        downloadFile(await backup(), `decentrawiki-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')
      } }, icon('download'), 'Download a backup of every wiki')),
    h('section', { class: 'panel' },
      h('h2', {}, 'About'),
      h('p', { class: 'muted', id: 'about' }, 'DecentraWiki edits TiddlyWiki wikis and publishes them on IPFS. Its source is public, in the orivon-ports repository, and every published wiki carries its own readable source.'))))
}
