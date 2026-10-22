import { h, setText } from './dom.js'
import { humanSize } from './helpers.js'
import { kindIcon } from './icons.js'
import { collectDropped } from './drop.js'
import { createArticleForm, createFilesForm, FILE_FORMS } from './forms.js'

const CHOICES = [
  { id: 'article', kind: 'article', label: 'Article', blurb: 'Write a page. Visitors read it in any browser that opens .onion sites.' },
  { id: 'picture', kind: 'picture', label: 'Picture', blurb: 'Share one picture, large on its own page, with a link to download the original.' },
  { id: 'files', kind: 'file', label: 'Files', blurb: 'Share one or more files as a list people can download.' },
  { id: 'folder', kind: 'folder', label: 'Folder', blurb: 'Share a whole folder. Visitors see a list of its files.' },
  { id: 'website', kind: 'website', label: 'Website', blurb: 'Serve a folder exactly as it is. It needs an index.html at its top.' }
]

function hasFiles (event) {
  return Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes('Files')
}

export function createPublish (store, { onPublished }) {
  const forms = { article: createArticleForm() }
  for (const config of FILE_FORMS) forms[config.id] = createFilesForm(config)

  let active = 'article'
  let submitting = false
  let phaseRunning = false

  const message = h('p', { class: 'msg', 'aria-live': 'polite', hidden: true })
  function say (text, tone) {
    message.hidden = !text
    message.className = `msg msg-${tone || 'ok'}`
    setText(message, text || '')
  }

  const tabs = CHOICES.map((choice) => h('button', {
    type: 'button',
    role: 'tab',
    id: `tab-${choice.id}`,
    class: 'tab',
    'aria-controls': `panel-${choice.id}`,
    'aria-selected': 'false',
    tabindex: '-1'
  }, kindIcon(choice.kind), h('span', null, choice.label)))

  const panels = CHOICES.map((choice) => h('div', {
    role: 'tabpanel',
    id: `panel-${choice.id}`,
    class: 'panel',
    'aria-labelledby': `tab-${choice.id}`,
    hidden: true
  }, h('p', { class: 'blurb' }, choice.blurb), forms[choice.id].el))

  function select (id, focus) {
    active = id
    CHOICES.forEach((choice, i) => {
      const on = choice.id === id
      tabs[i].setAttribute('aria-selected', String(on))
      tabs[i].tabIndex = on ? 0 : -1
      panels[i].hidden = !on
      if (on && focus) tabs[i].focus()
    })
    say('')
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(CHOICES[i].id, false))
    tab.addEventListener('keydown', (event) => {
      const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: CHOICES.length - 1 }
      if (!(event.key in moves)) return
      event.preventDefault()
      select(CHOICES[(moves[event.key] + CHOICES.length) % CHOICES.length].id, true)
    })
  })

  const busyLabel = h('span', { class: 'busy-label' })
  const busyCount = h('span', { class: 'mono busy-count' })
  const busyFill = h('span', { class: 'bar-fill' })
  const busyBar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Publishing', 'aria-valuemin': 0, 'aria-valuemax': 100 }, busyFill)
  const busy = h('div', { class: 'busy', hidden: true }, h('div', { class: 'progress-head' }, busyLabel, busyCount), busyBar)

  const publishButton = h('button', { type: 'button', class: 'btn btn-primary' }, 'Publish')
  const gate = h('p', { class: 'hint' })

  async function submit () {
    if (submitting || !phaseRunning || store.getState().busy) return
    const form = forms[active]
    const result = form.collect()
    if (result.error) {
      say(result.error, 'bad')
      return
    }
    submitting = true
    sync()
    say('')
    try {
      const id = await result.run(store.actions)
      form.reset()
      say('Published. A new onion service takes a minute or two to become reachable.', 'ok')
      onPublished(id)
    } catch (error) {
      say(error && error.message ? error.message : 'Publishing failed.', 'bad')
    } finally {
      submitting = false
      sync()
    }
  }
  publishButton.addEventListener('click', submit)

  function sync () {
    const working = submitting || Boolean(store.getState().busy)
    publishButton.disabled = !phaseRunning || working
    setText(publishButton, working ? 'Publishing…' : 'Publish')
    setText(gate, phaseRunning ? '' : 'Publishing opens once Tor is running.')
  }

  // Dropping a file anywhere else would make the page navigate to it.
  for (const type of ['dragover', 'drop']) {
    document.addEventListener(type, (event) => { if (hasFiles(event)) event.preventDefault() })
  }
  const stage = h('div', { class: 'panels' }, panels)
  let depth = 0
  stage.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return
    depth++
    stage.classList.add('is-drag')
  })
  stage.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) stage.classList.remove('is-drag')
  })
  stage.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.dataTransfer.dropEffect = 'copy'
  })
  stage.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return
    depth = 0
    stage.classList.remove('is-drag')
    const form = forms[active]
    if (active === 'article') {
      say('Files cannot go into an article. Choose Picture, Files, Folder or Website first.', 'bad')
      return
    }
    try {
      const files = await collectDropped(event.dataTransfer, form.directory)
      if (files.length === 0) {
        say(form.directory ? 'Drop a folder here, not single files.' : 'Drop files here, not folders. Use Folder to share a folder.', 'bad')
        return
      }
      say('')
      form.setFiles(files)
    } catch {
      say('Could not read what was dropped. Use the button to choose it instead.', 'bad')
    }
  })

  select('article', false)

  const el = h('section', { class: 'card publish', id: 'publish', 'aria-labelledby': 'publish-title' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('h2', { id: 'publish-title' }, 'Publish on an onion address'),
        h('p', { class: 'muted' }, 'Each publication gets its own permanent .onion address, served from this computer while TorSocks is open.')
      )
    ),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'What to publish' }, tabs),
    stage,
    busy,
    h('div', { class: 'actions-row' }, publishButton, gate),
    message
  )

  return {
    el,
    focus () {
      tabs[CHOICES.findIndex((choice) => choice.id === active)].focus()
    },
    update (state) {
      phaseRunning = state.phase === 'running'
      busy.hidden = !state.busy
      if (state.busy) {
        const { label, done, total } = state.busy
        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
        setText(busyLabel, label)
        setText(busyCount, total > 0 ? `${humanSize(done)} / ${humanSize(total)}` : '')
        busyFill.style.width = `${pct}%`
        busyBar.classList.toggle('is-indeterminate', total <= 0)
        if (total > 0) busyBar.setAttribute('aria-valuenow', String(pct))
        else busyBar.removeAttribute('aria-valuenow')
      }
      sync()
    }
  }
}
