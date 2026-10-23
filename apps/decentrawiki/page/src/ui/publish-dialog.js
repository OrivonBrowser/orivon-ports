// The Publish dialog: where to pin, the steps as they happen, and the result
// with every address the published wiki opens at.

import { h, icon, replace } from '../dom.js'
import { fileNameFor, formatAgo, formatBytes, formatDay, shortCid } from '../format.js'
import { addressSite, addressesOf, carOf, pinSite, recordPublication, renderSite } from '../publish/publish.js'
import { FREE, FREE_DAYS, describe, defaultTargetId, freeUntil, loadTargets } from '../publish/targets.js'
import { copyText, downloadFile, openDialog } from './dialog.js'

/** @typedef {import('../store.js').Wiki} Wiki @typedef {import('../publish/targets.js').Target} Target */

const DOWNLOAD = 'download'

/** One line of the progress list. @param {string} text */
function stepRow (text) {
  const mark = h('span', { class: 'step-mark' })
  const row = h('li', { class: 'progress-step' }, mark, h('span', {}, text))
  return {
    row,
    /** @param {'active' | 'done' | 'failed'} state */
    set (state) {
      row.className = `progress-step progress-${state}`
      replace(mark, state === 'done' ? icon('check') : state === 'failed' ? icon('alert') : h('span', { class: 'spinner' }))
    }
  }
}

/** @param {string} cid @param {string} title @param {number | null} keptUntil When free pinning stops keeping it, if it was pinned there. */
function result (cid, title, keptUntil) {
  const where = addressesOf(cid)
  const box = h('div', { class: 'cid-box' },
    h('code', { class: 'cid' }, where.ipfs),
    h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Copy the address', onclick: () => copyText(where.ipfs, 'Address') }, icon('copy')))
  return [
    h('div', { class: 'success' }, h('span', { class: 'success-mark' }, icon('check')), h('div', {},
      h('h3', {}, `“${title}” is on IPFS`),
      h('p', { class: 'muted' }, 'Anyone with this address can read it, and press the pen to edit their own copy.'))),
    box,
    keptUntil === null
      ? null
      : h('div', { class: 'notice' }, icon('history'), h('p', {}, `Orivon keeps this version pinned until ${formatDay(keptUntil)}. To keep it up after that, pin the address on your own node or a pinning service, or publish with one of them from Settings.`)),
    h('div', { class: 'row' },
      h('a', { class: 'button button-secondary', href: where.ipfs, target: '_blank', rel: 'noopener' }, icon('open'), 'Open it'),
      h('a', { class: 'button button-ghost', href: where.gateway, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Open on a public gateway')),
    h('details', { class: 'explain' },
      h('summary', {}, 'Give it a name'),
      h('p', {}, 'To publish it under an ENS name, open the name in the ENS app, then Records, and set its Content Hash to ', h('code', {}, where.ipfs), '. Readers of the name then get this version, and each later version you publish replaces it when you set the new address.')),
    h('details', { class: 'explain' },
      h('summary', {}, 'Keep it available'),
      h('p', {}, keptUntil === null
        ? 'A wiki on IPFS stays reachable while some node pins it. The service you published with pins it now; pinning it on a second service or your own node keeps it up if one of them stops.'
        : `A wiki on IPFS stays reachable while some node pins it. Free pinning keeps each version for ${FREE_DAYS} days, once: a new version you publish gets ${FREE_DAYS} days of its own. Anyone who pins the address keeps it up too.`))
  ]
}

/**
 * @param {{ wiki: Wiki, workspace: import('../workspace.js').Workspace, onSettings: () => void, onPublished: (wiki: Wiki) => void }} options
 */
export async function openPublishDialog ({ wiki, workspace, onSettings, onPublished }) {
  const targets = await loadTargets()
  const preferred = await defaultTargetId()
  let choice = targets.some((t) => t.id === preferred) ? preferred : targets[0]?.id ?? FREE.id
  const controller = new AbortController()

  /** @param {string} id @param {string} label @param {string} hint */
  const option = (id, label, hint) => {
    const radio = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'target', value: id, checked: id === choice }))
    radio.addEventListener('change', () => { choice = id })
    return h('label', { class: 'choice' }, radio, h('span', { class: 'choice-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, hint)))
  }
  const last = wiki.publications.at(-1)
  const chooser = [
    h('p', {}, 'Publishing builds this wiki as a static page, computes its IPFS address here, and pins it. Anyone with the address can read it. What is published on IPFS cannot be called back: copies may outlive yours.'),
    last ? h('p', { class: 'muted small' }, `Last published ${formatAgo(last.at)} as ${shortCid(last.cid)}. A new version gets a new address.`) : null,
    h('fieldset', { class: 'choices' }, h('legend', {}, 'Pin it with'),
      option(FREE.id, describe(FREE), `No account needed. Kept for ${FREE_DAYS} days, until ${formatDay(freeUntil(Date.now()))}; pin it elsewhere to keep it longer.`),
      targets.map((target) => option(target.id, describe(target), 'Pinned now, under the account or node you set up')),
      option(DOWNLOAD, 'Nobody: download the files', 'A CAR file you can pin anywhere with `ipfs dag import`')),
    targets.length === 0
      ? h('p', { class: 'notice notice-plain' }, icon('settings'), h('span', {}, 'To keep wikis pinned for as long as you like, ', h('button', { type: 'button', class: 'link-button', onclick: () => { dialog.close(); onSettings() } }, 'set up your own node or a pinning service'), '.'))
      : null
  ]

  const dialog = openDialog({
    title: `Publish “${wiki.title}”`,
    body: chooser,
    onClose: () => controller.abort(),
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
      { label: 'Publish', kind: 'primary', autofocus: true, onClick: () => { void run() } }
    ]
  })

  async function run () {
    const target = choice === FREE.id ? FREE : targets.find((t) => t.id === choice)
    const steps = {
      build: stepRow('Building the static page'),
      address: stepRow('Computing its IPFS address'),
      ...(target ? { pin: stepRow(`Pinning it with ${describe(target)}`), check: stepRow('Checking the address the service reports') } : {})
    }
    const message = h('p', { class: 'form-status', role: 'status' })
    dialog.setBody(h('ol', { class: 'progress' }, Object.values(steps).map((s) => s.row)), message)
    dialog.setBusy(true)
    dialog.setActions([{ label: 'Publishing…', kind: 'primary', disabled: true }])
    /** @type {keyof typeof steps} */
    let current = 'build'
    try {
      steps.build.set('active')
      const files = await renderSite(workspace, wiki)
      steps.build.set('done')
      current = 'address'
      steps.address.set('active')
      const site = await addressSite(files)
      steps.address.set('done')
      if (target === undefined) {
        dialog.setBusy(false)
        const car = carOf(site)
        dialog.setBody(
          h('p', {}, `The wiki is ${formatBytes(site.size)}. Its IPFS address will be:`),
          h('div', { class: 'cid-box' }, h('code', { class: 'cid' }, `ipfs://${site.cid}/`), h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Copy the address', onclick: () => copyText(`ipfs://${site.cid}/`, 'Address') }, icon('copy'))),
          h('p', { class: 'muted' }, 'It opens there once a node pins it. Import the CAR file on your node with ', h('code', {}, 'ipfs dag import'), ', or upload it to a pinning service that takes CAR files.'))
        dialog.setActions([
          { label: 'Close', kind: 'ghost', onClick: () => dialog.close() },
          { label: 'Download the CAR file', kind: 'primary', autofocus: true, onClick: async () => {
            downloadFile(car, `${fileNameFor(wiki.title)}-${site.cid.slice(-8)}.car`, 'application/vnd.ipld.car')
            const updated = await recordPublication(wiki.id, { cid: site.cid, at: Date.now(), target: 'Downloaded as a CAR file', size: site.size })
            if (updated) onPublished(updated)
          } }
        ])
        return
      }
      current = 'pin'
      steps.pin?.set('active')
      message.textContent = `Uploading ${formatBytes(site.size)}…`
      const keptUntil = target === FREE ? freeUntil(Date.now()) : null
      const targetName = keptUntil === null ? describe(target) : `${describe(target)}, until ${formatDay(keptUntil)}`
      const updated = await pinSite(wiki, target, site, { signal: controller.signal, targetName })
      steps.pin?.set('done')
      current = 'check'
      steps.check?.set('done')
      dialog.setBusy(false)
      dialog.setBody(...result(site.cid, wiki.title, keptUntil))
      dialog.setActions([{ label: 'Done', kind: 'primary', autofocus: true, onClick: () => dialog.close() }])
      if (updated) onPublished(updated)
    } catch (error) {
      steps[current]?.set('failed')
      dialog.setBusy(false)
      message.className = 'form-status form-status-error'
      message.textContent = error instanceof Error ? error.message : String(error)
      dialog.setActions([
        { label: 'Close', kind: 'ghost', onClick: () => dialog.close() },
        { label: 'Try again', kind: 'primary', onClick: () => { void run() } }
      ])
    }
  }
}

/** Every version of a wiki that was published from this browser. @param {Wiki} wiki */
export function openPublications (wiki) {
  const list = [...wiki.publications].reverse()
  const dialog = openDialog({
    title: `Publications of “${wiki.title}”`,
    wide: true,
    body: list.length === 0
      ? [h('p', { class: 'muted' }, 'Not published from this browser yet.')]
      : [h('ul', { class: 'publications' }, list.map((p) => {
          const where = addressesOf(p.cid)
          return h('li', { class: 'publication' },
            h('div', {}, h('code', { class: 'cid', title: p.cid }, shortCid(p.cid)), h('p', { class: 'muted small' }, `${formatAgo(p.at)} · ${p.target} · ${formatBytes(p.size)}`)),
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Copy the address', onclick: () => copyText(where.ipfs, 'Address') }, icon('copy')),
              h('a', { class: 'icon-button', href: where.ipfs, target: '_blank', rel: 'noopener', 'aria-label': 'Open it' }, icon('open'))))
        }))],
    actions: [{ label: 'Close', kind: 'primary', onClick: () => dialog.close() }]
  })
}
