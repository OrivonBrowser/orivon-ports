// A protected website shown inside the page, in Orivon: the unlocked files are served from a loopback
// listener (engine.startSiteServer) and shown in a full-window <webview>, each site at an origin of its own.
// The shown page has no `orivon.*` and none of this page's grants. Orivon tells the page about a window the
// site asks for (`orivon-popup`) and a download it starts (`orivon-download`); neither happens on its own.

import * as engine from '../engine.js'
import { h, icon, replace } from '../dom.js'
import { hostOf } from '../format.js'
import * as store from '../store.js'
import { downloadBlob } from '../ui/dialog.js'

/** How long the webview may take to come up before the viewer says so. */
const READY_MS = 15_000

/**
 * @param {{ cid: string, title: string, entries: { path: string, size: number, file: Blob }[], onClose?: () => void }} options
 * @returns {{ close: () => void }}
 */
export function openSiteViewer ({ cid, title, entries, onClose }) {
  const topbar = document.getElementById('topbar')
  const main = document.getElementById('view')
  const banner = document.getElementById('banner')
  const opener = /** @type {HTMLElement | null} */ (document.activeElement)
  /** @type {null | { url: string, origin: string, stop: () => void }} */
  let site = null
  let closed = false
  /** @type {any} */
  let view = null

  const state = h('div', { class: 'viewer-state', role: 'status' }, h('span', { class: 'spinner spinner-large' }), h('span', {}, 'Opening the website…'))
  const notice = h('div', { class: 'viewer-notice hidden', role: 'alert' })
  const stage = h('div', { class: 'viewer-stage' }, state)
  const back = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Back', disabled: true, onclick: () => view?.goBack() }, icon('back'))
  const forward = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Forward', disabled: true, onclick: () => view?.goForward() }, icon('forward'))
  const reload = h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Reload', onclick: () => view?.reload() }, icon('reload'))
  const closeButton = h('button', { type: 'button', class: 'button button-secondary', onclick: () => close() }, icon('close'), 'Close')
  const zipButton = h('button', { type: 'button', class: 'button button-ghost', onclick: () => { void zip() } }, icon('download'), h('span', { class: 'hide-narrow' }, 'Download (.zip)'))
  const panel = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'viewer-bar' }, back, forward, reload, h('span', { class: 'viewer-title' }, title), zipButton, closeButton),
    notice, stage)

  /** @param {...any} children */
  function say (...children) {
    replace(notice, ...children)
    notice.classList.remove('hidden')
  }

  async function zip () {
    zipButton.disabled = true
    try {
      downloadBlob(await engine.zipEntries(entries), `${title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'website'}.zip`)
    } catch (error) {
      say(h('p', {}, error instanceof Error ? error.message : String(error)))
    } finally {
      zipButton.disabled = false
    }
  }

  function close () {
    if (closed) return
    closed = true
    panel.removeEventListener('keydown', keys)
    try { view?.remove() } catch { /* the element may already be gone */ }
    site?.stop()
    panel.remove()
    for (const el of [topbar, main, banner]) el?.removeAttribute('inert')
    opener?.focus()
    onClose?.()
  }

  /** @param {KeyboardEvent} event */
  function keys (event) {
    if (event.key === 'Escape') close()
  }

  /** @param {{ url: string, disposition: string }} request */
  function popup (request) {
    const url = request.url
    if (site !== null && url.startsWith(site.origin)) {
      void view.loadURL(url)
      return
    }
    if (!/^https?:/i.test(url)) {
      say(h('p', {}, 'The site tried to open something this page does not open.'))
      return
    }
    const host = hostOf(url)
    say(h('p', {}, `The site wants to open ${host}.`),
      h('button', { type: 'button', class: 'button button-secondary button-small', onclick: () => { notice.classList.add('hidden'); window.open(url, '_blank', 'noopener,noreferrer') } }, 'Open in a new tab'),
      h('button', { type: 'button', class: 'button button-ghost button-small', onclick: () => notice.classList.add('hidden') }, 'Stay here'))
  }

  function syncButtons () {
    try {
      back.toggleAttribute('disabled', !view?.canGoBack())
      forward.toggleAttribute('disabled', !view?.canGoForward())
    } catch { /* the guest is not attached yet */ }
  }

  async function show () {
    try {
      site = await engine.startSiteServer(cid, entries, await store.viewerSecret())
      if (closed) { site.stop(); return }
      view = document.createElement('webview')
      view.setAttribute('aria-label', title)
      view.setAttribute('src', 'about:blank')
      view.addEventListener('orivon-popup', (/** @type {any} */ event) => popup(event.detail))
      view.addEventListener('orivon-download', () => say(h('p', {}, 'Downloads from a shared site are not kept. “Download (.zip)” above saves the whole website.')))
      for (const name of ['did-navigate', 'did-navigate-in-page', 'did-finish-load']) view.addEventListener(name, syncButtons)
      const attached = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The viewer did not start. Close it and try again.')), READY_MS)
        view.addEventListener('did-finish-load', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
      })
      stage.append(view)
      await attached
      await view.loadURL(site.url)
      state.remove()
    } catch (error) {
      if (closed) return
      replace(state, icon('alert', 'icon icon-large'), h('span', {}, error instanceof Error ? error.message : String(error)))
    }
  }

  for (const el of [topbar, main, banner]) el?.setAttribute('inert', '')
  panel.addEventListener('keydown', keys)
  document.body.append(panel)
  closeButton.focus()
  void show()
  return { close }
}
