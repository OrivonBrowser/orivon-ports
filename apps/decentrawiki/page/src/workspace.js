// A wiki being edited: TiddlyWiki in a frame sandboxed to an origin of its own,
// so a wiki's own scripts and plugins never reach the editor's storage or keys.
// The frame sends each change as it happens and this page keeps it, in order.
// The other half is ../frame-boot.js and $:/plugins/orivon/decentrawiki-frame.

import * as store from './store.js'
import { keepChanges } from './wikis.js'
import { h } from './dom.js'

const PROTOCOL = 'decentrawiki-frame'
const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads'
const BOOT_TIMEOUT_MS = 45000
const RENDER_TIMEOUT_MS = 60000

/** @typedef {'loading' | 'saved' | 'saving' | 'failed'} Status */

export class Workspace {
  /**
   * @param {import('./store.js').Wiki} wiki
   * @param {{ onStatus: (status: Status, detail?: string) => void, open?: { title: string, edit: boolean } | null }} options
   */
  constructor (wiki, { onStatus, open = null }) {
    this.wiki = wiki
    this.onStatus = onStatus
    this.openFirst = open
    /** @type {HTMLIFrameElement | null} */
    this.frame = null
    this.booted = false
    this.saving = Promise.resolve()
    this.pending = 0
    this.renderId = 0
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.renders = new Map()
    this.onMessage = this.onMessage.bind(this)
  }

  /** @param {HTMLElement} container */
  mount (container) {
    this.frame = /** @type {HTMLIFrameElement} */ (h('iframe', { class: 'wiki-frame', title: `Editing ${this.wiki.title}`, sandbox: SANDBOX, src: 'frame.html' }))
    window.addEventListener('message', this.onMessage)
    container.append(this.frame)
    this.onStatus('loading')
    this.bootTimer = setTimeout(() => {
      if (!this.booted) this.onStatus('failed', 'The wiki did not start. Reload the page to try again.')
    }, BOOT_TIMEOUT_MS)
  }

  destroy () {
    window.removeEventListener('message', this.onMessage)
    clearTimeout(this.bootTimer)
    for (const { reject } of this.renders.values()) reject(new Error('The wiki was closed'))
    this.renders.clear()
    this.frame?.remove()
    this.frame = null
  }

  /** @param {MessageEvent} event */
  onMessage (event) {
    const data = event.data
    if (this.frame === null || event.source !== this.frame.contentWindow || data === null || typeof data !== 'object' || data.protocol !== PROTOCOL) return
    switch (data.type) {
      case 'ready':
        void this.load()
        break
      case 'booted':
        this.booted = true
        clearTimeout(this.bootTimer)
        this.onStatus('saved')
        break
      case 'boot-failed':
        this.onStatus('failed', `The wiki could not start: ${String(data.message).slice(0, 200)}`)
        break
      case 'changes':
        this.keep(Array.isArray(data.put) ? data.put : [], Array.isArray(data.removed) ? data.removed : [])
        break
      case 'rendered':
      case 'render-failed': {
        const waiting = this.renders.get(data.id)
        if (waiting === undefined) return
        this.renders.delete(data.id)
        if (data.type === 'rendered' && typeof data.html === 'string') waiting.resolve({ html: data.html, favicon: data.favicon ?? null })
        else waiting.reject(new Error(`The wiki could not be built for publishing: ${String(data.message ?? 'no page came back').slice(0, 200)}`))
        break
      }
    }
  }

  async load () {
    const tiddlers = await store.getTiddlers(this.wiki.id)
    this.post({ type: 'load', tiddlers, open: this.openFirst })
  }

  /** @param {unknown[]} put @param {unknown[]} removed */
  keep (put, removed) {
    this.pending++
    this.onStatus('saving')
    this.saving = this.saving.then(() => keepChanges(this.wiki.id, put, removed)).then(() => {
      this.pending--
      if (this.pending === 0) this.onStatus('saved')
    }, (error) => {
      this.pending--
      this.onStatus('failed', `A change could not be kept: ${error?.message ?? error}. Download a backup from the library before closing this page.`)
    })
  }

  /** Resolves once every change the frame sent so far is kept. */
  async settled () {
    let last
    do {
      last = this.saving
      await last
    } while (last !== this.saving)
  }

  /** @param {string} title @param {boolean} edit */
  open (title, edit) {
    this.post({ type: 'open', title, edit })
  }

  /**
   * The wiki as it will be published. `extra` are tiddlers only the published
   * copy carries (its lineage).
   * @param {Record<string, string>[]} extra
   * @returns {Promise<{ html: string, favicon: { type: string, text: string } | null }>}
   */
  render (extra) {
    if (!this.booted) return Promise.reject(new Error('The wiki is still starting. Wait a moment and try again.'))
    const id = ++this.renderId
    return new Promise((resolve, reject) => {
      this.renders.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.renders.delete(id)) reject(new Error('Building the wiki for publishing took too long.'))
      }, RENDER_TIMEOUT_MS)
      this.post({ type: 'render', id, extra })
    })
  }

  /** @param {Record<string, unknown>} message */
  post (message) {
    // The frame's origin is opaque, so no origin can be named; the message goes to that one window only.
    this.frame?.contentWindow?.postMessage({ protocol: PROTOCOL, ...message }, '*')
  }
}
