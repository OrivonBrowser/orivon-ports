// Settings: the services that can also keep a share online, how this computer serves and stores shares,
// what this browser remembers, and the theme.

import * as engine from '../engine.js'
import { h, icon, replace } from '../dom.js'
import { formatBytes } from '../format.js'
import * as store from '../store.js'
import { confirmDialog, toast } from '../ui/dialog.js'
import { liveServing } from '../ui/serving.js'
import { defaultServiceId, describeKeeping, describeService, loadServices, saveServices, setDefaultService } from '../ui/services.js'
import { applyTheme, themeOf } from '../ui/theme.js'
import { storageLine } from './share-actions.js'
import { openTargetDialog } from './target-dialog.js'

/** @typedef {import('../engine.js').Target} Service */

/** @param {unknown} error */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {Service} service @param {string | null} preferred @param {() => void} refresh */
function serviceRow (service, preferred, refresh) {
  const status = h('span', { class: 'small', role: 'status' })
  const isDefault = service.id === preferred
  return h('li', { class: 'target' },
    h('div', { class: 'target-main' },
      h('strong', {}, describeService(service), isDefault ? h('span', { class: 'badge badge-lock' }, 'Default') : null),
      h('span', { class: 'muted small' }, describeKeeping(service)),
      status),
    h('div', { class: 'row' },
      isDefault ? null : h('button', { type: 'button', class: 'button button-ghost button-small', onclick: async () => { await setDefaultService(service.id); refresh() } }, 'Use for new shares'),
      h('button', { type: 'button', class: 'button button-ghost button-small', onclick: async () => {
        status.className = 'small muted'
        status.textContent = 'Checking…'
        try {
          await engine.testTarget(service, { signal: new AbortController().signal })
          status.className = 'small form-status-ok'
          status.textContent = 'It answers, and accepts the key.'
        } catch (error) {
          status.className = 'small form-status-error'
          status.textContent = messageOf(error)
        }
      } }, 'Test'),
      h('button', { type: 'button', class: 'button button-ghost button-small', onclick: () => openTargetDialog({ target: service, onSaved: refresh }) }, 'Change'),
      h('button', { type: 'button', class: 'icon-button', 'aria-label': `Remove ${describeService(service)}`, onclick: async () => {
        if (!await confirmDialog({ title: `Remove ${describeService(service)}?`, message: 'Its key is deleted from this browser. Shares already kept there stay where they are.', confirm: 'Remove', danger: true })) return
        await saveServices((await loadServices()).filter((candidate) => candidate.id !== service.id))
        if (isDefault) await setDefaultService(null)
        refresh()
      } }, icon('trash'))))
}

/** @param {HTMLElement} view @param {{ signal: AbortSignal }} ctx */
export async function renderSettings (view, ctx) {
  const [saved, preferred, shares, theme, storage] = await Promise.all([
    loadServices(), defaultServiceId(), store.listShares(), store.getSetting('theme', 'system'), engine.storageInfo().catch(() => null)
  ])
  if (ctx.signal.aborted) return
  const refresh = () => { void renderSettings(view, ctx) }
  const environment = engine.environment()
  const remembered = shares.filter((share) => share.password !== undefined).length

  const themeChoice = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Theme' }, [['system', 'Same as my device'], ['light', 'Light'], ['dark', 'Dark']].map(([id, label]) => {
    const button = h('button', { type: 'button', role: 'radio', class: 'segment', 'aria-checked': String(themeOf(theme) === id) }, label)
    button.addEventListener('click', async () => {
      applyTheme(themeOf(id))
      await store.setSetting('theme', id)
      for (const other of themeChoice.querySelectorAll('.segment')) other.setAttribute('aria-checked', String(other === button))
    })
    return button
  }))
  const persist = storage && !storage.persisted
    ? h('button', { type: 'button', class: 'button button-secondary button-small', onclick: async () => {
        toast(await store.askToPersist() ? 'The browser will keep Share\'s storage' : 'The browser did not agree. Shares stay for as long as it has room.')
        refresh()
      } }, 'Ask the browser to keep it')
    : null

  replace(view,
    h('div', { class: 'page-head' }, h('h1', {}, 'Settings')),
    h('section', { class: 'card', 'aria-label': 'Services' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, 'Keep shares online when Share is closed'),
          h('p', { class: 'muted' }, 'A share is shared from this computer while Orivon Share is open. A service of yours can also keep it online when it is not. Each is checked: the page accepts a service only when it reports the share\'s own address.')),
        h('button', { type: 'button', class: 'button button-primary', onclick: () => openTargetDialog({ onSaved: refresh }) }, icon('plus'), 'Add a service')),
      saved.length === 0
        ? h('p', { class: 'empty' }, 'No service yet. Add IPFS Desktop or Kubo, Filebase, Pinata or any Kubo-compatible service.')
        : h('ul', { class: 'targets' }, saved.map((service) => serviceRow(service, preferred, refresh))),
      preferred !== null ? h('div', { class: 'row block' }, h('button', { type: 'button', class: 'button button-ghost button-small', onclick: async () => { await setDefaultService(null); refresh() } }, 'Do not use any by default')) : null),
    h('section', { class: 'card', 'aria-label': 'This computer' },
      h('h2', {}, 'This computer'),
      h('p', { class: 'muted' }, storageLine(storage, formatBytes)),
      persist ? h('div', { class: 'row block' }, persist) : null,
      h('p', { class: 'block' }, liveServing((state) => {
        const { connected, total } = state.trackers
        if (!state.supported) return 'This browser cannot connect computers directly (it has no WebRTC), so shares cannot be served from here. A service or a CAR file still works.'
        if (connected > 0) return `Connected to ${connected} of ${total} servers that introduce people to this computer. They see a fingerprint of each share and your IP address, never the share.`
        return state.shares.some((share) => share.online)
          ? 'Connecting to the servers that introduce people to this computer. They only make introductions: a share travels directly between computers.'
          : 'Share connects to the servers that introduce people to this computer only while it is sharing something. They only make introductions: a share travels directly between computers.'
      })),
      environment.pageNode
        ? h('p', { class: 'muted block' }, 'Orivon\'s IPFS node, in this page, also serves your shares to the IPFS network when this computer can be reached from outside.')
        : null),
    h('section', { class: 'card', 'aria-label': 'What this browser remembers' },
      h('h2', {}, 'What this browser remembers'),
      h('p', { class: 'muted' }, `${shares.length === 0 ? 'No shares in My shares' : `${shares.length} ${shares.length === 1 ? 'share' : 'shares'} in My shares`}${remembered > 0 ? `, ${remembered} with a remembered password` : ''}. Keys of services you added are kept here too.`),
      h('div', { class: 'row block' },
        h('button', { type: 'button', class: 'button button-secondary', disabled: remembered === 0, onclick: async () => {
          if (!await confirmDialog({ title: 'Forget remembered passwords?', message: 'My shares will no longer show the passwords. Make sure you still have them: a protected share cannot be opened without its password.', confirm: 'Forget them', danger: true })) return
          const dropped = await store.forgetPasswords()
          toast(`${dropped} ${dropped === 1 ? 'password' : 'passwords'} forgotten`)
          refresh()
        } }, icon('key'), 'Forget remembered passwords'),
        h('button', { type: 'button', class: 'button button-secondary', disabled: shares.length === 0, onclick: async () => {
          if (!await confirmDialog({ title: 'Clear the list of shares?', message: 'This clears the list and the passwords kept with it. The shares stay on this computer and keep being shared; they show in My shares without a title, and each can be deleted there.', confirm: 'Clear the list', danger: true })) return
          await store.clearShares()
          toast('The list is cleared')
          refresh()
        } }, icon('trash'), 'Clear my shares'))),
    h('section', { class: 'card', 'aria-label': 'Appearance' },
      h('h2', {}, 'Appearance'), h('div', { class: 'block' }, themeChoice)))
}
