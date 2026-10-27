// The Publish dialog: which address the wiki goes under, where to pin, the steps as they happen, and the
// result. The address is chosen first because the published page carries it.

import { h, icon, replace } from '../dom.js'
import { fileNameFor, formatAgo, formatBytes, formatDay, shortCid } from '../format.js'
import { getName, loadNames, makeName } from '../names.js'
import { pointName } from '../publish/name-step.js'
import { addressSite, addressesOf, attachSequence, carOf, nameAddressesOf, pinSite, recordPublication, renderSite } from '../publish/publish.js'
import { freeFromPageNode } from '../publish/page-node.js'
import { FREE, FREE_DAYS, describe, defaultTargetId, freeUntil, loadTargets, recordName } from '../publish/targets.js'
import * as store from '../store.js'
import { linkWikiToName } from '../wikis.js'
import { copyText, downloadFile, openDialog, toast } from './dialog.js'
import { addressFieldset } from './address-choice.js'
import { openKeyDialog } from './import-key.js'
import { carDoneView, resultView } from './publish-result.js'

/** @typedef {import('../store.js').Wiki} Wiki @typedef {import('../publish/targets.js').Target} Target */

const DOWNLOAD = 'download'

/** The route a publish took, in the one error line a bug report carries. @param {Target | undefined} target @param {boolean} fromNode */
function routeOf (target, fromNode) {
  if (target === undefined) return 'as a CAR file'
  if (target.kind !== 'free') return `with ${target.kind}`
  return fromNode ? 'free pinning from the page\'s IPFS node' : 'free pinning as an upload'
}

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

/**
 * @param {{ wiki: Wiki, workspace: import('../workspace.js').Workspace, onSettings: () => void, onPublished: (wiki: Wiki) => void }} options
 */
export async function openPublishDialog ({ wiki: opened, workspace, onSettings, onPublished }) {
  let wiki = opened
  const targets = await loadTargets()
  const preferred = await defaultTargetId()
  const fromNode = await freeFromPageNode()
  let held = await loadNames()
  let choice = targets.some((t) => t.id === preferred) ? preferred : targets[0]?.id ?? FREE.id
  const controller = new AbortController()
  /** An address this dialog made: a retry goes on with it, and the result offers its key. @type {{ kind: 'update', name: string } | null} */
  let made = null
  /** @type {ReturnType<typeof addressFieldset>} */
  let address

  /** @param {string} id @param {string} label @param {string} hint */
  const option = (id, label, hint) => {
    const radio = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'target', value: id, checked: id === choice }))
    radio.addEventListener('change', () => { choice = id })
    return h('label', { class: 'choice' }, radio, h('span', { class: 'choice-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, hint)))
  }

  function chooser () {
    address = addressFieldset({
      wiki,
      held,
      onImportKey: () => openKeyDialog({ lookup: false, onChanged: async () => { held = await loadNames(); dialog.setBody(...chooser()) } })
    })
    const last = wiki.publications.at(-1)
    return [
      h('p', {}, 'Publishing builds this wiki as a static page, computes its IPFS address here, and pins it. Publishing now also points the wiki\'s address at the new version. Anyone with an address can read it. What is published on IPFS cannot be called back: copies may outlive yours.'),
      last ? h('p', { class: 'muted small' }, `Last published ${formatAgo(last.at)} as ${shortCid(last.cid)}. Each version has an address of its own; the wiki's address follows the newest.`) : null,
      address.el,
      h('fieldset', { class: 'choices' }, h('legend', {}, 'Pin it with'),
        option(FREE.id, describe(FREE, fromNode), fromNode
          ? `This page runs an IPFS node and publishes the wiki from it. Orivon's node reads it from yours and keeps it pinned for ${FREE_DAYS} days, until ${formatDay(freeUntil(Date.now()))}. Pin it elsewhere to keep it longer.`
          : `No account needed: the wiki goes to Orivon's server, which keeps it pinned for ${FREE_DAYS} days, until ${formatDay(freeUntil(Date.now()))}. Pin it elsewhere to keep it longer.`),
        targets.map((target) => option(target.id, describe(target), 'Pinned now, under the account or node you set up')),
        option(DOWNLOAD, 'Nobody: download the files', 'A CAR file you can pin anywhere with `ipfs dag import`')),
      targets.length === 0
        ? h('p', { class: 'notice notice-plain' }, icon('settings'), h('span', {}, 'To keep wikis pinned for as long as you like, ', h('button', { type: 'button', class: 'link-button', onclick: () => { dialog.close(); onSettings() } }, 'set up your own node or a pinning service'), '.'))
        : null
    ]
  }

  const dialog = openDialog({
    title: `Publish “${wiki.title}”`,
    body: chooser(),
    onClose: () => controller.abort(),
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => dialog.close() },
      { label: 'Publish', kind: 'primary', autofocus: true, onClick: () => { void run() } }
    ]
  })

  /** Makes the address a new publish goes under, and takes it as the wiki's. @returns {Promise<string>} */
  async function makeAddress () {
    const entry = await makeName(wiki.title)
    await linkWikiToName(wiki.id, entry.name)
    wiki = (await store.getWiki(wiki.id)) ?? wiki
    made = { kind: 'update', name: entry.name }
    onPublished(wiki)
    return entry.name
  }

  async function run () {
    const target = choice === FREE.id ? FREE : targets.find((t) => t.id === choice)
    const selection = made ?? address.get()
    const steps = {
      ...(selection.kind === 'new' ? { make: stepRow('Making its address') } : {}),
      build: stepRow('Building the static page'),
      address: stepRow('Computing its IPFS address'),
      ...(target ? { pin: stepRow(target === FREE && fromNode ? 'Publishing it from your IPFS node' : `Pinning it with ${describe(target)}`), check: stepRow('Checking the address the service reports'), ...(selection.kind === 'none' ? {} : { point: stepRow('Pointing its address at this version') }) } : {})
    }
    const message = h('p', { class: 'form-status', role: 'status' })
    dialog.setBody(h('ol', { class: 'progress' }, Object.values(steps).map((s) => s.row)), message)
    dialog.setBusy(true)
    dialog.setActions([{ label: 'Publishing…', kind: 'primary', disabled: true }])
    /** @type {keyof typeof steps} */
    let current = 'build'
    try {
      /** @type {string | null} */
      let name = selection.kind === 'update' || selection.kind === 'other' ? selection.name : null
      if (name !== null && await getName(name) === undefined) {
        throw new Error('This browser does not hold the key of that address any more. Close this, import the key or choose another address.')
      }
      if (selection.kind === 'new') {
        current = 'make'
        steps.make?.set('active')
        name = await makeAddress()
        steps.make?.set('done')
      }
      current = 'build'
      steps.build.set('active')
      const files = await renderSite(workspace, wiki, name)
      steps.build.set('done')
      current = 'address'
      steps.address.set('active')
      const site = await addressSite(files)
      steps.address.set('done')
      const title = wiki.title
      if (target === undefined) {
        carStep(site, name, title)
        return
      }
      current = 'pin'
      steps.pin?.set('active')
      message.textContent = `Uploading ${formatBytes(site.size)}…`
      const { keptUntil } = await pinSite(wiki, target, site, { fromNode, signal: controller.signal, onStep: (text) => { message.textContent = text } })
      steps.pin?.set('done')
      current = 'check'
      steps.check?.set('done')
      let point = null
      if (name !== null) {
        current = 'point'
        steps.point?.set('active')
        message.textContent = 'Orivon\'s node is checking the version and keeping the address…'
        point = await pointName({ name, cid: site.cid, title, send: true, signal: controller.signal })
        if (point.sequence !== null) await linkWikiToName(wiki.id, name)
        if (point.problem === null) steps.point?.set('done')
      }
      const updated = await recordPublication(wiki.id, {
        cid: site.cid, at: Date.now(), target: recordName(target, keptUntil, fromNode), size: site.size,
        ...(name !== null && point?.sequence != null ? { name, sequence: point.sequence } : {})
      })
      dialog.setBusy(false)
      const cid = site.cid
      const retry = async () => {
        if (name === null) return { keptUntil: null, problem: null }
        const again = await pointName({ name, cid, title, send: true, signal: controller.signal })
        if (again.sequence !== null) {
          await linkWikiToName(wiki.id, name)
          const attached = await attachSequence(wiki.id, cid, name, again.sequence)
          if (attached) onPublished(attached)
        }
        return { keptUntil: again.keptUntil, problem: again.problem }
      }
      dialog.setBody(...resultView({ cid, title, keptUntil, name, fromNode, made: made !== null, point, retry }))
      dialog.setActions([{ label: 'Done', kind: 'primary', autofocus: true, onClick: () => dialog.close() }])
      if (updated) onPublished(updated)
    } catch (error) {
      steps[current]?.set('failed')
      dialog.setBusy(false)
      message.className = 'form-status form-status-error'
      const said = error instanceof Error ? error.message : String(error)
      message.textContent = said
      console.error(`[decentrawiki] publish failed at the ${current} step, ${routeOf(target, fromNode)}: ${said}`)
      dialog.setActions([
        { label: 'Close', kind: 'ghost', onClick: () => dialog.close() },
        { label: 'Try again', kind: 'primary', onClick: () => { void run() } }
      ])
    }
  }

  /**
   * Nobody pins it: the address is computed, the CAR file is offered, and the record is signed when the file is saved.
   * @param {import('../publish/publish.js').Site} site @param {string | null} name @param {string} title
   */
  function carStep (site, name, title) {
    dialog.setBusy(false)
    const car = carOf(site)
    const where = addressesOf(site.cid).ipfs
    dialog.setBody(
      h('p', {}, `The wiki is ${formatBytes(site.size)}. Its IPFS address will be:`),
      h('div', { class: 'cid-box' }, h('code', { class: 'cid' }, where), h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Copy the address', onclick: () => copyText(where, 'Address') }, icon('copy'))),
      name === null ? null : h('p', {}, 'The wiki\'s address, ', h('code', {}, nameAddressesOf(name).ipns), ', will point at it.'),
      h('p', { class: 'muted' }, 'It opens there once a node pins it. Import the CAR file on your node with ', h('code', {}, 'ipfs dag import'), ', or upload it to a pinning service that takes CAR files.'))
    dialog.setActions([
      { label: 'Close', kind: 'ghost', onClick: () => dialog.close() },
      { label: 'Download the CAR file', kind: 'primary', autofocus: true, onClick: async () => {
        dialog.setBusy(true)
        const point = name === null ? null : await pointName({ name, cid: site.cid, title, send: false })
        if (point?.problem) toast(point.problem, { kind: 'error', timeout: 9000 })
        if (name !== null && point?.sequence != null) await linkWikiToName(wiki.id, name)
        downloadFile(car, `${fileNameFor(title)}-${site.cid.slice(-8)}.car`, 'application/vnd.ipld.car')
        const updated = await recordPublication(wiki.id, {
          cid: site.cid, at: Date.now(), target: 'Downloaded as a CAR file', size: site.size,
          ...(name !== null && point?.sequence != null ? { name, sequence: point.sequence } : {})
        })
        if (updated) onPublished(updated)
        dialog.setBusy(false)
        dialog.setBody(...carDoneView({ cid: site.cid, name: point?.sequence == null ? null : name, made: made !== null }))
        dialog.setActions([{ label: 'Done', kind: 'primary', autofocus: true, onClick: () => dialog.close() }])
      } }
    ])
  }
}
