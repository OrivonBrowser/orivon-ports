// My shares: what was sent from this browser. A share is kept on this computer and served from it while
// Share is open; here it can be put offline, kept with a service, saved as a CAR file or deleted.

import * as engine from '../engine.js'
import { h, icon, replace } from '../dom.js'
import { count, formatAgo, formatBytes, shortCid } from '../format.js'
import * as store from '../store.js'
import { confirmDialog, copyText, toast } from '../ui/dialog.js'
import { rememberKey } from '../ui/keys.js'
import { liveServing, nodeText, peersText, uploadedText } from '../ui/serving.js'
import { keepElsewhere, saveCar, stopAndDelete, storageLine } from './share-actions.js'

const KIND_ICONS = /** @type {const} */ ({ files: 'files', folder: 'folder', website: 'globe' })

/** @param {import('../store.js').ShareRecord} share */
function statusBadges (share) {
  return liveServing((state) => {
    const kept = state.shares.find((candidate) => candidate.cid === share.cid)
    return [
      share.at === 0 ? null : share.encrypted ? h('span', { class: 'badge badge-lock' }, icon('lock'), 'Protected') : h('span', { class: 'badge' }, 'Public'),
      kept === undefined
        ? h('span', { class: 'badge badge-warn' }, 'Not on this computer')
        : kept.online ? h('span', { class: 'badge badge-ok' }, icon('shield'), 'Online from this computer') : h('span', { class: 'badge' }, 'Offline'),
      share.services.map((service) => h('span', { class: 'badge' }, icon('clock'), `Also kept with ${service.label}`))
    ]
  }, 'div', { class: 'badges' })
}

/** @param {import('../store.js').ShareRecord} share */
function activity (share) {
  return liveServing((state) => {
    const kept = state.shares.find((candidate) => candidate.cid === share.cid)
    if (!kept?.online) return null
    const node = nodeText(kept.node)
    return [`${peersText(kept.peers)} · ${uploadedText(kept.uploaded)}`, node ? ` · ${node}` : null]
  }, 'p', { class: 'muted small', 'aria-live': 'polite' })
}

/** @param {import('../store.js').ShareRecord} share @param {() => void} refresh */
function row (share, refresh) {
  const kept = engine.servingState().shares.find((candidate) => candidate.cid === share.cid)
  const link = engine.shareLink(share.cid, share.keyInLink ? share.password : undefined)
  const online = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', role: 'switch', checked: kept?.online === true }))
  online.addEventListener('change', async () => {
    online.disabled = true
    try {
      await engine.setOnline(share.cid, online.checked)
    } catch (error) {
      online.checked = !online.checked
      toast(error instanceof Error ? error.message : String(error), { kind: 'error', timeout: 8000 })
    } finally {
      online.disabled = false
    }
  })
  return h('li', { class: 'share-row' },
    h('div', { class: 'share-row-top' },
      h('span', { class: 'share-bubble' }, icon(share.encrypted ? 'lock' : KIND_ICONS[share.kind])),
      h('div', { class: 'share-title' },
        h('h3', {}, share.title),
        h('p', { class: 'muted small' }, share.at === 0 ? 'Kept on this computer, but not in your list any more' : `${count(share.files, 'file')}, ${formatBytes(share.bytes)} · ${formatAgo(share.at)}`),
        statusBadges(share), activity(share))),
    kept === undefined
      ? h('p', { class: 'field-help' }, 'This computer no longer holds the share. It is reachable only where a service keeps it.')
      : h('label', { class: 'switch' }, online, h('span', { class: 'switch-track' }),
          h('span', { class: 'switch-text' }, h('strong', {}, 'Share from this computer'), h('span', { class: 'muted small' }, 'On: people can open the link while Orivon Share is open. Off: it stays here but nobody can reach it.'))),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'button button-secondary button-small', onclick: () => copyText(link, 'Link') }, icon('copy'), 'Copy link'),
      share.password ? h('button', { type: 'button', class: 'button button-secondary button-small', onclick: () => copyText(/** @type {string} */ (share.password), 'Password') }, icon('key'), 'Copy password') : null,
      h('a', { class: 'button button-secondary button-small', href: `#/${share.cid}`, onclick: () => { if (share.password) rememberKey(share.cid, share.password) } }, icon('open'), 'Open')),
    h('details', { class: 'explain' },
      h('summary', {}, 'More'),
      h('div', { class: 'row' },
        kept === undefined ? null : h('button', { type: 'button', class: 'button button-secondary button-small', onclick: () => { void keepElsewhere(share.cid, refresh) } }, icon('upload'), 'Keep it online elsewhere'),
        kept === undefined ? null : h('button', { type: 'button', class: 'button button-secondary button-small', onclick: () => { void saveCar(share.cid) } }, icon('download'), 'Download as a CAR file'),
        kept === undefined
          ? h('button', { type: 'button', class: 'button button-ghost button-small', onclick: async () => {
              if (!await confirmDialog({ title: 'Remove it from this list?', message: 'This only takes it off the list. Copies kept with a service stay where they are.', confirm: 'Remove from the list', danger: true })) return
              await store.deleteShare(share.cid)
              refresh()
            } }, icon('trash'), 'Remove from the list')
          : h('button', { type: 'button', class: 'button button-outline-danger button-small', onclick: () => { void stopAndDelete(share, refresh) } }, icon('trash'), 'Stop sharing and delete from this computer'))))
}

/** @param {HTMLElement} view @param {{ signal: AbortSignal }} ctx */
export async function renderShares (view, ctx) {
  const [shares, storage] = await Promise.all([store.listShares(), engine.storageInfo().catch(() => null)])
  if (ctx.signal.aborted) return
  const refresh = () => { void renderShares(view, ctx) }
  // A share kept here whose list entry was cleared still needs a way to be stopped and deleted.
  const listed = new Set(shares.map((share) => share.cid))
  /** @type {import('../store.js').ShareRecord[]} */
  const unlisted = engine.servingState().shares.filter((kept) => !listed.has(kept.cid))
    .map((kept) => ({ cid: kept.cid, kind: 'files', encrypted: false, title: `Share ${shortCid(kept.cid)}`, bytes: 0, files: 0, at: 0, keyInLink: false, services: [] }))
  const all = [...shares, ...unlisted]
  replace(view,
    h('div', { class: 'page-head' },
      h('h1', {}, 'My shares'),
      h('p', { class: 'lead' }, 'What you shared from this browser. Each is kept on this computer and shared from it while Orivon Share is open.')),
    all.length === 0
      ? h('div', { class: 'card centered' }, icon('files', 'icon icon-large'), h('h2', {}, 'Nothing shared from this browser yet'), h('p', { class: 'muted' }, 'Shares you make show up here, with their link.'),
          h('a', { class: 'button button-primary', href: '#/' }, icon('upload'), 'Share something'))
      : h('ul', { class: 'shares' }, all.map((share) => row(share, refresh))),
    h('p', { class: 'field-help block' }, storageLine(storage, formatBytes), ' ', h('a', { href: '#/settings' }, 'Settings'), ' has more.'))
}
