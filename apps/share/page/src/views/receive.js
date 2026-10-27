// Opening a share from its link: read it from IPFS (every block checked), then show its files, offer the
// website, or ask for the password and show what it unlocks.

import * as engine from '../engine.js'
import { h, icon, replace } from '../dom.js'
import { count, fileNameFor, formatBytes, formatDay, nameOfEntries } from '../format.js'
import { copyField } from '../ui/copy-field.js'
import { downloadBlob, toast } from '../ui/dialog.js'
import { keyFor } from '../ui/keys.js'
import { alertText, announce } from '../ui/live.js'
import { stepList } from '../ui/progress.js'
import { openSiteViewer } from '../viewer/view.js'
import { fileList } from './receive-files.js'

const UNLOCK_STEPS = /** @type {const} */ ([['download', 'Reading the locked file'], ['decrypt', 'Unlocking']])
const KIND_ICONS = /** @type {const} */ ({ files: 'files', folder: 'folder', website: 'globe' })

const STALLED_MS = 20_000

/** @typedef {'peer' | 'gateway' | 'local'} Source */

/** @param {Source | null | undefined} source */
function sourceText (source) {
  return source === 'peer' ? 'the sender\'s computer' : source === 'gateway' ? 'IPFS gateways' : source === 'local' ? 'this computer' : null
}

/** @param {import('../engine.js').Progress & { source?: Source }} p */
function progressText (p) {
  const from = sourceText(p.source)
  const amount = p.total ? `${formatBytes(p.done ?? 0)} of ${formatBytes(p.total)}` : p.text ?? 'Reading…'
  return from ? `${amount}, from ${from}` : amount
}

/** @param {Source | null} source */
function sourceBadge (source) {
  const text = sourceText(source)
  return text === null ? null : h('span', { class: 'badge' }, icon(source === 'gateway' ? 'globe' : 'link'), `Read from ${text}`)
}

/** @param {unknown} error */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {{ iconName: import('../dom.js').IconName, title: string, meta: string, badges?: any[] }} options */
function head ({ iconName, title, meta, badges = [] }) {
  return h('div', { class: 'share-head' },
    h('span', { class: 'share-bubble' }, icon(iconName)),
    h('div', { class: 'share-title' }, h('h1', {}, title), h('p', { class: 'muted' }, meta), badges.length > 0 ? h('div', { class: 'badges' }, badges) : null))
}

const checkedBadge = () => h('span', { class: 'badge badge-ok' }, icon('shield'), 'Checked against its IPFS address')

/** The addresses a share has outside this page. @param {string} cid @param {boolean} encrypted */
function addressesBlock (cid, encrypted) {
  return h('details', { class: 'explain' },
    h('summary', {}, 'About this share'),
    h('p', {}, 'Its address is a fingerprint of what it holds. This page read every piece and checked it against that address, so what you see is what was shared.'),
    copyField({ value: `ipfs://${cid}`, label: 'IPFS address' }),
    encrypted
      ? h('div', {}, h('p', {}, 'Without this page: any program that reads age files opens it. Download share.age from the address above, then:'),
          h('pre', { class: 'commands' }, 'age -d -o share.zip share.age\nunzip share.zip'))
      : null)
}

/**
 * @param {HTMLElement} view
 * @param {{ signal: AbortSignal, onCleanup: (fn: () => void) => void }} ctx
 * @param {string} cid
 */
export async function renderReceive (view, ctx, cid) {
  /** @type {{ close: () => void } | null} */
  let viewer = null
  /** Where the bytes came from, as the engine last said. @type {Source | null} */
  let source = null
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let stalledTimer
  ctx.onCleanup(() => { viewer?.close(); clearTimeout(stalledTimer); engine.closeShare(cid) })
  /** @param {...any} children */
  const page = (...children) => { if (!ctx.signal.aborted) replace(view, ...children) }
  const environment = engine.environment()
  /** Whether this page may show a website inside itself: Orivon, and the person's permission. */
  const canEmbed = environment.embed && await Promise.race([engine.embedAvailable(), new Promise((resolve) => setTimeout(() => resolve(false), 3000))])

  async function open () {
    const bar = h('progress', { class: 'bar hidden', max: '100', value: '0', 'aria-label': 'Progress' })
    const detail = h('p', { class: 'muted small' })
    const stalled = h('div', { class: 'notice notice-warn hidden', role: 'status' }, icon('info'), h('div', {},
      h('strong', {}, 'Still looking for it'),
      h('p', {}, 'Nobody has answered yet. The person who shared it needs Orivon Share open on their computer, or the share needs to be kept with a pinning service. You can wait, or try again later.')))
    let lastDone = -1
    const arm = () => {
      clearTimeout(stalledTimer)
      stalled.classList.add('hidden')
      stalledTimer = setTimeout(() => stalled.classList.remove('hidden'), STALLED_MS)
    }
    arm()
    page(h('section', { class: 'card centered', 'aria-label': 'Opening the share' },
      h('span', { class: 'spinner spinner-large' }),
      h('h1', {}, 'Opening the share…'),
      h('p', { class: 'muted' }, 'Looking for it on the sender\'s computer and on IPFS gateways, and checking every piece against its address.'),
      bar, detail, stalled))
    announce('Opening the share')
    try {
      // The engine's runtime (kept shares, introductions) has to exist before a share is read, or it is read from gateways only.
      await engine.startServing().catch(() => {})
      const share = await engine.openShare(cid, {
        signal: ctx.signal,
        onProgress: (p) => {
          if ((p.done ?? 0) > lastDone || (p.source && p.source !== source)) arm()
          lastDone = Math.max(lastDone, p.done ?? 0)
          source = p.source ?? source
          detail.textContent = progressText(p)
          if (p.total) {
            bar.classList.remove('hidden')
            bar.setAttribute('value', String(Math.min(100, Math.floor(((p.done ?? 0) / p.total) * 100))))
          }
        }
      })
      clearTimeout(stalledTimer)
      if (ctx.signal.aborted) return
      if (share.encrypted) unlockPage(share)
      else publicPage(share)
    } catch (error) {
      clearTimeout(stalledTimer)
      if (ctx.signal.aborted) return
      console.error('Opening a share failed', error)
      alertText(messageOf(error))
      page(h('section', { class: 'card centered', 'aria-label': 'The share could not be opened' },
        icon('alert', 'icon icon-large'),
        h('h1', {}, 'This share could not be opened'),
        h('p', {}, messageOf(error)),
        h('p', { class: 'muted small' }, 'Check your connection and try again. The person who shared it needs Orivon Share open on their computer, or the share needs to be kept with a pinning service.'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'button button-primary', onclick: () => { void open() } }, icon('reload'), 'Try again'),
          h('a', { class: 'button button-ghost', href: '#/' }, 'Share something'))))
    }
  }

  /** @param {Awaited<ReturnType<typeof engine.openShare>>} share */
  function publicPage (share) {
    const kind = share.kind ?? 'files'
    const title = nameOfEntries(share.entries, kind)
    // The source is learned from the first file read, since the directory's own blocks carry none.
    const sourceSlot = h('span', {})
    /** @param {Source | undefined} found */
    const noteSource = (found) => { if (found) { source = found; replace(sourceSlot, sourceBadge(found)) } }
    const body = kind === 'website'
      ? [h('div', { class: 'row block' },
          h('a', { class: 'button button-primary button-large', href: environment.orivon ? `ipfs://${share.cid}/` : `https://${share.cid}.ipfs.dweb.link/`, target: '_blank', rel: 'noopener noreferrer' }, icon('open'), 'Open website'),
          canEmbed ? openHereButton(share) : null),
         h('p', { class: 'field-help' }, environment.orivon
           ? 'Opens in a new tab, read through the IPFS network.' + (canEmbed ? ' If that finds nothing because only the sender\'s computer holds the share, “Open it in Share” reads it from there.' : '')
           : 'Opens in a new tab, through a public IPFS gateway. It loads once a pinning service or an IPFS node holds the share.'),
         h('details', { class: 'explain' }, h('summary', {}, 'Browse the files'), filesView(share, noteSource))]
      : [h('div', { class: 'row block' }, zipButton(share, title, noteSource)), h('div', { class: 'block' }, filesView(share, noteSource))]
    page(h('section', { class: 'card', 'aria-label': 'The share' },
      head({ iconName: KIND_ICONS[kind], title, meta: `${count(share.entries.length, 'file')}, ${formatBytes(share.bytes)}`, badges: [checkedBadge(), sourceSlot] }),
      ...body, addressesBlock(share.cid, false)))
    announce('The share is open')
  }

  /** @param {Awaited<ReturnType<typeof engine.openShare>>} share @param {(source: Source | undefined) => void} noteSource */
  function filesView (share, noteSource) {
    return fileList({
      entries: share.entries,
      read: (path, onText) => engine.readPublicFile(share, path, { signal: ctx.signal, onProgress: (p) => { noteSource(p.source); onText(progressText(p)) } })
    })
  }

  /** Reads a public website here and shows it in the viewer, which works whoever holds the share. @param {Awaited<ReturnType<typeof engine.openShare>>} share */
  function openHereButton (share) {
    const button = h('button', { type: 'button', class: 'button button-secondary button-large' }, icon('globe'), 'Open it in Share')
    const note = h('span', { class: 'muted small', role: 'status' })
    button.addEventListener('click', async () => {
      button.setAttribute('disabled', '')
      try {
        /** @type {{ path: string, size: number, file: Blob }[]} */
        const entries = []
        for (const entry of share.entries) {
          note.textContent = `Reading file ${entries.length + 1} of ${share.entries.length}…`
          entries.push({ path: entry.path, size: entry.size, file: await engine.readPublicFile(share, entry.path, { signal: ctx.signal, onProgress: () => {} }) })
        }
        note.textContent = ''
        viewer = openSiteViewer({ cid: share.cid, title: 'Website', entries, onClose: () => { viewer = null } })
      } catch (error) {
        note.textContent = ''
        if (!ctx.signal.aborted) toast(messageOf(error), { kind: 'error', timeout: 8000 })
      } finally {
        button.removeAttribute('disabled')
      }
    })
    return h('span', { class: 'row' }, button, note)
  }

  /** @param {Awaited<ReturnType<typeof engine.openShare>>} share @param {string} title @param {(source: Source | undefined) => void} noteSource */
  function zipButton (share, title, noteSource) {
    const button = h('button', { type: 'button', class: 'button button-primary' }, icon('zip'), 'Download all (.zip)')
    const note = h('span', { class: 'muted small', role: 'status' })
    button.addEventListener('click', async () => {
      button.setAttribute('disabled', '')
      try {
        downloadBlob(await engine.zipPublic(share, { signal: ctx.signal, onProgress: (p) => { noteSource(p.source); note.textContent = progressText(p) } }), `${fileNameFor(title, 'share')}.zip`)
        note.textContent = ''
      } catch (error) {
        if (!ctx.signal.aborted) toast(messageOf(error), { kind: 'error', timeout: 8000 })
        note.textContent = ''
      } finally {
        button.removeAttribute('disabled')
      }
    })
    return h('div', { class: 'row' }, button, note)
  }

  /** @param {Awaited<ReturnType<typeof engine.openShare>>} share */
  function unlockPage (share) {
    const input = /** @type {HTMLInputElement} */ (h('input', { class: 'input input-mono', id: 'unlock-password', type: 'password', autocomplete: 'off', spellcheck: 'false' }))
    const status = h('p', { class: 'form-status form-status-error', role: 'alert' })
    const submit = /** @type {HTMLButtonElement} */ (h('button', { type: 'submit', class: 'button button-primary button-large' }, icon('unlock'), 'Unlock'))
    const steps = stepList(UNLOCK_STEPS, [])
    steps.el.classList.add('hidden')
    const show = h('input', { type: 'checkbox', onchange: () => { input.type = /** @type {HTMLInputElement} */ (show).checked ? 'text' : 'password' } })
    const form = h('form', { class: 'unlock' },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'unlock-password' }, 'Password'), input),
      h('label', { class: 'check' }, show, h('span', {}, 'Show the password')),
      submit, status, steps.el)
    form.addEventListener('submit', (event) => { event.preventDefault(); void attempt(input.value, false) })

    /** @param {string} password @param {boolean} fromLink */
    async function attempt (password, fromLink) {
      if (password === '') {
        status.textContent = 'Enter the password first.'
        input.focus()
        return
      }
      status.textContent = ''
      submit.disabled = true
      input.disabled = true
      steps.el.classList.remove('hidden')
      try {
        const unlocked = await engine.unlockShare(share, password, { signal: ctx.signal, onProgress: (p) => { source = p.source ?? source; steps.update(p) } })
        if (ctx.signal.aborted) return
        steps.finish()
        unlockedPage(share, unlocked)
      } catch (error) {
        if (ctx.signal.aborted) return
        if (!(error instanceof Error && error.name === 'WrongPasswordError')) console.error('Unlocking a share failed', error)
        steps.el.classList.add('hidden')
        submit.disabled = false
        input.disabled = false
        status.textContent = error instanceof Error && error.name === 'WrongPasswordError'
          ? (fromLink ? 'The password in this link did not work. Enter the right one.' : 'That password did not open the share. Check it and try again.')
          : messageOf(error)
        input.select()
        input.focus()
        alertText(status.textContent)
      }
    }

    page(h('section', { class: 'card', 'aria-label': 'A protected share' },
      h('div', { class: 'centered' },
        h('span', { class: 'share-bubble' }, icon('lock')),
        h('h1', {}, 'This share is protected'),
        h('p', { class: 'muted' }, 'Enter the password you were given. It is checked on this device: it is never sent to anyone.'),
        h('div', { class: 'badges' }, checkedBadge(), sourceBadge(source))),
      form, addressesBlock(share.cid, true)))
    const linked = keyFor(share.cid)
    if (linked !== null) {
      input.value = linked
      void attempt(linked, true)
    } else input.focus()
  }

  /** @param {Awaited<ReturnType<typeof engine.openShare>>} share @param {Awaited<ReturnType<typeof engine.unlockShare>>} unlocked */
  function unlockedPage (share, unlocked) {
    const title = unlocked.title || nameOfEntries(unlocked.entries, unlocked.kind)
    const made = Date.parse(unlocked.created)
    const bytes = unlocked.entries.reduce((sum, entry) => sum + entry.size, 0)
    const zip = () => engine.zipEntries(unlocked.entries)
    const zipAll = () => {
      const button = h('button', { type: 'button', class: unlocked.kind === 'website' && canEmbed ? 'button button-secondary' : 'button button-primary' }, icon('zip'), unlocked.kind === 'website' ? 'Download the website (.zip)' : 'Download all (.zip)')
      button.addEventListener('click', async () => {
        button.setAttribute('disabled', '')
        try {
          downloadBlob(await zip(), `${fileNameFor(title, 'share')}.zip`)
        } catch (error) {
          toast(messageOf(error), { kind: 'error', timeout: 8000 })
        } finally {
          button.removeAttribute('disabled')
        }
      })
      return button
    }
    const files = fileList({ entries: unlocked.entries, read: async (path) => /** @type {Blob} */ (unlocked.entries.find((entry) => entry.path === path)?.file) })
    /** @type {any[]} */
    let body
    if (unlocked.kind === 'website') {
      body = [
        h('div', { class: 'row block' },
          canEmbed
            ? h('button', { type: 'button', class: 'button button-primary button-large', onclick: () => { viewer = openSiteViewer({ cid: share.cid, title, entries: unlocked.entries, onClose: () => { viewer = null } }) } }, icon('open'), 'Open the website')
            : null,
          zipAll()),
        canEmbed
          ? h('p', { class: 'field-help' }, 'It opens right here, in a space of its own that cannot see anything of this page.')
          : h('div', { class: 'notice' }, icon('info'), h('div', {}, h('strong', {}, environment.orivon ? 'This page cannot show websites yet.' : 'Orivon opens protected websites in place.'),
              h('p', {}, environment.orivon
                ? 'Allow it to show websites in this app\'s permissions, or download the website and open its index.html.'
                : 'In another browser, download the website, unzip it and open its index.html.'))),
        h('details', { class: 'explain' }, h('summary', {}, 'Browse the files'), files)
      ]
    } else {
      body = [h('div', { class: 'row block' }, zipAll()), h('div', { class: 'block' }, files)]
    }
    page(h('section', { class: 'card', 'aria-label': 'The unlocked share' },
      head({
        iconName: KIND_ICONS[unlocked.kind], title,
        meta: `${count(unlocked.entries.length, 'file')}, ${formatBytes(bytes)}${Number.isNaN(made) ? '' : ` · shared ${formatDay(made)}`}`,
        badges: [h('span', { class: 'badge badge-lock' }, icon('unlock'), 'Unlocked'), checkedBadge(), sourceBadge(source)]
      }),
      unlocked.message ? h('p', { class: 'share-message' }, unlocked.message) : null,
      ...body, addressesBlock(share.cid, true)))
    announce('Unlocked')
  }

  await open()
}
