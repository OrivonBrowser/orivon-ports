// The Send page: what to share, whether to lock it, where to keep it, and the Share button. What was
// chosen lives at module level, so a visit to Settings (to add a service) does not lose it, and a
// share that is being made carries on while another page is open.

import * as engine from '../engine.js'
import { h, icon, replace } from '../dom.js'
import { count, formatBytes, nameOfEntries } from '../format.js'
import { siteTitleOf } from '../lib/site-title.js'
import * as store from '../store.js'
import { alertText, announce } from '../ui/live.js'
import { toast } from '../ui/dialog.js'
import { rememberKey } from '../ui/keys.js'
import { SHARE_STEPS, stepList } from '../ui/progress.js'
import { defaultServiceId, describeService, loadServices } from '../ui/services.js'
import { keepCard, passwordCard, passwordProblem } from './send-options.js'
import { resultCard, runningCard } from './send-result.js'
import { dropZone, kindOfDrop, selectionCard, withoutDuplicates } from './send-select.js'

/** @typedef {import('../engine.js').Entry} Entry @typedef {import('../engine.js').Kind} Kind @typedef {import('./send-result.js').Job} Job */
/** @typedef {import('./send-options.js').Options & { entries: Entry[], kind: Kind }} Form */

/** @param {string | null} serviceId @returns {Form} */
function freshForm (serviceId) {
  return { entries: [], kind: 'files', protect: false, password: '', showPassword: false, keyInLink: false, remember: false, title: '', message: '', serviceId }
}

/** @type {Form} */
let form = freshForm(null)
/** @type {Job | null} */
let job = null
/** How much room this browser gives the page, read when the page opens. @type {{ used: number, quota: number, persisted: boolean } | null} */
let storage = null
/** Whether the person has chosen a service in this form: until then the default one applies. */
let formTouched = false
/** The page showing the Send view now, if any. @type {{ view: HTMLElement, signal: AbortSignal } | null} */
let mount = null

/** Whether a share is being made: leaving the page would lose it. */
export function sharing () {
  return job?.phase === 'running'
}

/** @param {unknown} error */
function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {HTMLElement} view @param {{ signal: AbortSignal, onCleanup: (fn: () => void) => void }} ctx */
export async function renderSend (view, ctx) {
  mount = { view, signal: ctx.signal }
  ctx.onCleanup(() => { if (mount?.view === view && mount.signal === ctx.signal) mount = null })
  if (job !== null) {
    paintJob()
    return
  }
  const services = await loadServices()
  storage = await engine.storageInfo().catch(() => null)
  if (ctx.signal.aborted) return
  if (form.serviceId !== null && !services.some((service) => service.id === form.serviceId)) form.serviceId = null
  if (!formTouched && form.serviceId === null) form.serviceId = await defaultServiceId()
  if (ctx.signal.aborted) return
  paintForm(services)
}

/** @param {import('../ui/services.js').Service[]} services */
function paintForm (services) {
  if (mount === null || mount.signal.aborted) return
  const hasSelection = form.entries.length > 0
  const check = hasSelection ? engine.checkSelection(form.entries, form.kind) : null
  const submit = h('div', { class: 'submit-bar' })

  /** Why the share cannot be made, or null. @param {{ bytes: number }} selected */
  function problemWith (selected) {
    if (selected.bytes > engine.LIMITS.maxShareBytes) return `A share holds up to ${formatBytes(engine.LIMITS.maxShareBytes)}. Split what you are sharing into more than one share.`
    if (storage && storage.quota > 0 && selected.bytes > storage.quota - storage.used) {
      return `There is not enough room in this browser's storage for it: about ${formatBytes(Math.max(0, storage.quota - storage.used))} is free. Free some space, or share less.`
    }
    return passwordProblem(form.password, form.protect)
  }

  function updateSubmit () {
    if (!check) return
    const problem = check.ok ? problemWith(check) : null
    const blocked = !check.ok || problem !== null
    const strength = form.protect && form.password !== '' ? engine.passwordStrength(form.password) : null
    replace(submit,
      h('p', { class: problem || !check.ok ? 'submit-note error' : 'submit-note', role: problem ? 'alert' : null },
        !check.ok ? 'Fix what is marked above to continue.' : problem
          ?? (strength?.label === 'fair' ? 'This password is only fair. A longer one is safer.' : `${count(check.files, 'file')}, ${formatBytes(check.bytes)}. ${form.protect ? 'Only people with the password can read it.' : 'Anyone with the link can read it.'}`)),
      h('button', { type: 'button', class: 'button button-primary button-large', disabled: blocked, onclick: () => { void start() } },
        icon(form.protect ? 'lock' : 'upload'), form.protect ? 'Lock and share' : 'Share'))
  }

  /** @param {import('./send-select.js').Origin} origin @param {Entry[] | Promise<Entry[]>} incoming */
  async function onPick (origin, incoming) {
    /** @type {Entry[]} */
    let entries
    try {
      entries = await incoming
    } catch (error) {
      toast(`That could not be read: ${messageOf(error)}`, { kind: 'error', timeout: 8000 })
      return
    }
    if (entries.length === 0) {
      toast('There was nothing to add. A folder with no files in it cannot be shared.', { kind: 'error', timeout: 6000 })
      return
    }
    const kind = origin === 'drop' ? kindOfDrop(entries) : origin === 'files' ? 'files' : origin
    if (kind === 'files' && form.kind === 'files' && form.entries.length > 0) form.entries = [...form.entries, ...withoutDuplicates(form.entries, entries)]
    else form.entries = entries
    form.kind = kind
    if (kind === 'folder' && engine.checkSelection(entries, 'website').ok) form.kind = 'website'
    announce(`${count(form.entries.length, 'file')} chosen`)
    paintForm(services)
  }

  const sections = hasSelection && check
    ? [
        selectionCard(form, check, {
          onRemove: (index) => { form.entries = form.entries.filter((_, i) => i !== index); paintForm(services) },
          onClear: () => { form.entries = []; form.kind = 'files'; paintForm(services) },
          onKind: (kind) => { form.kind = kind; paintForm(services) }
        }),
        passwordCard(form, { onChange: updateSubmit }),
        storage && !storage.durable
          ? h('div', { class: 'notice notice-warn', role: 'alert' }, icon('alert'), h('div', {}, h('strong', {}, 'This browser keeps no lasting storage for Share here.'), h('p', {}, 'The share is kept only until this page closes. Keep it with a service, or save the CAR file.')))
          : null,
        keepCard(form, services, { onChange: () => { formTouched = true; updateSubmit() } }),
        submit
      ]
    : [pointsList(), openCard()]
  replace(mount.view,
    h('div', { class: 'page-head' },
      h('h1', {}, 'Share files, folders or a website'),
      h('p', { class: 'lead' }, 'Pick what to share and get a link. Your computer shares it directly with whoever opens the link, for as long as Orivon Share stays open. Add a password and only the people who have it can read it.')),
    dropZone({ compact: hasSelection, onPick }),
    ...sections)
  updateSubmit()

  /** @returns {Promise<void>} */
  async function start () {
    const selected = engine.checkSelection(form.entries, form.kind)
    if (selected.ok) await share(services.find((service) => service.id === form.serviceId) ?? null, selected)
  }
}

function pointsList () {
  const point = (/** @type {import('../dom.js').IconName} */ name, /** @type {string} */ title, /** @type {string} */ text) =>
    h('li', {}, icon(name), h('strong', {}, title), h('span', {}, text))
  return h('ul', { class: 'points' },
    point('shield', 'Stays on your computer', 'It is shared straight from here to whoever opens the link, while Share is open. No server keeps it.'),
    point('lock', 'Public or locked', 'Add a password and the share is encrypted here, on your device, before anything leaves.'),
    point('globe', 'Files, folders, websites', 'A folder with an index.html opens as a website for whoever has the link.'))
}

function openCard () {
  const input = /** @type {HTMLInputElement} */ (h('input', { class: 'input input-mono', id: 'open-share', type: 'text', placeholder: 'https://share.orivonstack.eth.limo/#/bafy…', autocomplete: 'off', spellcheck: 'false' }))
  const status = h('p', { class: 'form-status form-status-error', role: 'alert' })
  const box = h('form', { class: 'input-group' }, input, h('button', { type: 'submit', class: 'button button-secondary' }, icon('open'), 'Open'))
  box.addEventListener('submit', (event) => {
    event.preventDefault()
    const parsed = engine.parseShareLink(input.value.trim())
    if (parsed === null) {
      status.textContent = 'That does not look like a share link or an IPFS address. Paste the whole link you were sent.'
      return
    }
    if (parsed.password) rememberKey(parsed.cid, parsed.password)
    location.hash = `#/${parsed.cid}`
  })
  return h('section', { class: 'card', 'aria-label': 'Open a share' },
    h('h2', {}, 'Got a link?'),
    h('p', { class: 'muted block' }, 'Paste it here to open a share someone sent you. Links also open straight from the address bar.'),
    h('div', { class: 'block' }, h('label', { class: 'sr-only', for: 'open-share' }, 'Link or address of a share'), box, status))
}

function paintJob () {
  if (mount === null || mount.signal.aborted || job === null) return
  const current = job
  replace(mount.view,
    h('h1', { class: 'sr-only' }, 'Share'),
    current.phase === 'done'
      ? resultCard(current, {
          onAnother: () => { job = null; form = freshForm(form.serviceId); void renderAgain() },
          onRetryService: () => { void retryService(current) }
        })
      : runningCard(current, {
          onCancel: () => current.controller.abort(),
          onBack: () => { job = null; void renderAgain() },
          onRetry: () => { void retry() }
        }))
  const focusTarget = mount.view.querySelector('h2')
  focusTarget?.setAttribute('tabindex', '-1')
  if (current.phase !== 'running') /** @type {HTMLElement | null} */ (focusTarget)?.focus()
}

async function renderAgain () {
  if (mount === null) return
  const { view, signal } = mount
  const services = await loadServices()
  if (signal.aborted || mount?.view !== view) return
  paintForm(services)
}

/** @param {Job} done */
async function retryService (done) {
  if (!done.service || !done.result) return
  const label = done.result.service?.label ?? describeService(done.service)
  try {
    await engine.pinElsewhere(done.result.cid, done.service, { signal: new AbortController().signal, onProgress: () => {} })
    done.result.service = { label, ok: true }
    await store.addService(done.result.cid, label).catch(() => {})
  } catch (error) {
    done.result.service = { label, ok: false, error: messageOf(error) }
  }
  if (job === done) paintJob()
}

async function retry () {
  const services = await loadServices()
  const selected = engine.checkSelection(form.entries, form.kind)
  if (selected.ok) await share(services.find((service) => service.id === form.serviceId) ?? null, selected)
}

/**
 * @param {import('../ui/services.js').Service | null} service the service to also keep the share with, if any
 * @param {Extract<ReturnType<typeof engine.checkSelection>, { ok: true }>} selected
 */
async function share (service, selected) {
  const encrypted = form.protect
  const entries = form.entries
  const expected = ['read', ...(encrypted ? ['encrypt'] : []), 'address', 'send', ...(service ? ['check'] : [])]
  const controller = new AbortController()
  const steps = stepList(SHARE_STEPS, expected)
  const title = encrypted ? form.title.trim() : ''
  /** @type {Job} */
  const mine = { controller, steps, phase: 'running', error: '', failedStep: '', result: null, password: encrypted ? form.password : '', title, encrypted, service }
  job = mine
  paintJob()
  try {
    const result = await engine.publishShare({
      kind: form.kind, entries: selected.entries, service, signal: controller.signal, onProgress: (progress) => steps.update(progress),
      ...(encrypted ? { password: form.password, keyInLink: form.keyInLink, title, message: form.message.trim() } : {})
    })
    steps.finish()
    mine.result = result
    mine.phase = 'done'
    // My shares names an untitled website as the people it is sent to will: by its own <title>. The folder's name, which they never see, is the fallback.
    const index = selected.entries.find((entry) => entry.path === 'index.html')
    const siteTitle = title === '' && result.kind === 'website' && index !== undefined ? await siteTitleOf(index.file) : ''
    await store.putShare({
      cid: result.cid, kind: result.kind, encrypted: result.encrypted, title: title || nameOfEntries(entries, result.kind, siteTitle), bytes: result.bytes, files: result.files,
      at: Date.now(), keyInLink: encrypted && form.keyInLink, services: result.service?.ok ? [{ label: result.service.label, at: Date.now() }] : [],
      ...(encrypted && form.remember ? { password: form.password } : {})
    }).catch(() => toast('The share is ready, but this browser would not add it to My shares.', { kind: 'error', timeout: 8000 }))
    announce('Your share is ready')
  } catch (error) {
    if (controller.signal.aborted) {
      if (job === mine) job = null
      toast('Cancelled. Nothing was shared.')
    } else {
      console.error('Share failed while', steps.currentLabel, error)
      mine.failedStep = steps.currentLabel
      steps.fail()
      mine.phase = 'failed'
      mine.error = messageOf(error)
      alertText(mine.error)
    }
  }
  if (job === mine) paintJob()
  else await renderAgain()
}
