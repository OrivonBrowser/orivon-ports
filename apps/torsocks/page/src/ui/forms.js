import { LIMITS } from '../model.js'
import { h, setText } from './dom.js'
import { kindIcon } from './icons.js'
import { articleCount, baseName, humanSize, pickProblem, summarizeFiles, topFolderName } from './helpers.js'

function field (id, label, control, hint) {
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    control,
    hint ? h('p', { class: 'hint', id: `${id}-hint` }, hint) : null
  )
}

function textInput (id, placeholder) {
  return h('input', { id, type: 'text', maxlength: LIMITS.titleLength, autocomplete: 'off', spellcheck: 'false', placeholder })
}

/** Forms are built once and only hidden and shown, so nothing the person typed or picked is lost. */
export function createArticleForm () {
  const title = textInput('article-title', 'A title for the page')
  const byline = textInput('article-byline', 'Leave empty to publish without a name')
  const body = h('textarea', {
    id: 'article-body',
    rows: 12,
    spellcheck: 'true',
    'aria-describedby': 'article-body-hint article-count',
    placeholder: 'Write here.'
  })
  const count = h('p', { class: 'counter mono', id: 'article-count' })

  function refresh () {
    const { text, tone } = articleCount(body.value.length)
    setText(count, text)
    count.dataset.tone = tone
  }
  body.addEventListener('input', refresh)
  refresh()

  const el = h('div', { class: 'form' },
    field('article-title', 'Title', title),
    field('article-byline', 'Byline (optional)', byline, 'Shown under the title. It is public, so use a name you are happy to have there.'),
    h('div', { class: 'field' },
      h('label', { for: 'article-body' }, 'Text'),
      body,
      h('p', { class: 'hint', id: 'article-body-hint' }, 'Markdown: # headings, **bold**, *italic*, `code`, > quotes, - lists, [links](…)'),
      count
    )
  )

  return {
    id: 'article',
    el,
    directory: false,
    focus: () => title.focus(),
    collect () {
      const heading = title.value.trim()
      if (!heading) return { error: 'Give the article a title.' }
      if (!body.value.trim()) return { error: 'Write something in the text first.' }
      if (body.value.length > LIMITS.articleLength) {
        return { error: `The text is ${body.value.length.toLocaleString('en-US')} characters. The limit is ${LIMITS.articleLength.toLocaleString('en-US')}.` }
      }
      const input = { title: heading, body: body.value, byline: byline.value.trim() }
      return { run: (actions) => actions.publishArticle(input) }
    },
    reset () {
      title.value = ''
      byline.value = ''
      body.value = ''
      refresh()
    }
  }
}

/**
 * @param {{ id: string, kind: string, accept?: string, multiple: boolean, directory: boolean,
 *   pick: string, empty: string, note?: { label: string, placeholder: string } }} config
 */
export function createFilesForm (config) {
  const inputId = `${config.id}-input`
  const input = h('input', {
    id: inputId,
    type: 'file',
    class: 'sr-only',
    accept: config.accept,
    multiple: config.multiple,
    webkitdirectory: config.directory
  })
  const title = textInput(`${config.id}-title`, 'A title for the page')
  const note = config.note
    ? h('textarea', { id: `${config.id}-note`, rows: 3, maxlength: 2000, placeholder: config.note.placeholder })
    : null
  let files = []
  let titleTouched = false

  const summary = h('p', { class: 'picked-summary mono' })
  const names = h('ul', { class: 'picked-names mono' })
  const problem = h('p', { class: 'msg msg-bad', role: 'status', hidden: true })
  const clear = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, 'Clear')
  const picked = h('div', { class: 'picked', hidden: true }, h('div', { class: 'picked-head' }, summary, clear), names, problem)

  function suggestion () {
    const folder = topFolderName(files)
    if (folder) return folder
    return files.length === 1 ? baseName(files[0].name) : ''
  }

  function render () {
    picked.hidden = files.length === 0
    if (files.length === 0) return
    const { count, bytes } = summarizeFiles(files)
    const folder = topFolderName(files)
    setText(summary, `${folder ? `${folder}: ` : ''}${count.toLocaleString('en-US')} ${count === 1 ? 'file' : 'files'}, ${humanSize(bytes)}`)
    names.replaceChildren(...files.slice(0, 5).map((file) => h('li', null, file.webkitRelativePath || file.name)))
    if (files.length > 5) names.append(h('li', { class: 'more' }, `and ${(files.length - 5).toLocaleString('en-US')} more`))
    const why = pickProblem(config.kind, files)
    problem.hidden = !why
    setText(problem, why)
  }

  function setFiles (next) {
    files = config.multiple || config.directory ? next : next.slice(0, 1)
    if (!titleTouched || title.value === '') title.value = suggestion().slice(0, LIMITS.titleLength)
    render()
  }

  input.addEventListener('change', () => setFiles(Array.from(input.files || [])))
  title.addEventListener('input', () => { titleTouched = true })
  clear.addEventListener('click', () => {
    input.value = ''
    setFiles([])
    input.focus()
  })

  const el = h('div', { class: 'form' },
    h('label', { class: 'dropzone', for: inputId },
      h('span', { class: 'dropzone-icon' }, kindIcon(config.kind)),
      h('span', { class: 'dropzone-text' },
        h('strong', null, config.pick),
        h('span', { class: 'muted' }, ' or drop it here')
      )
    ),
    input,
    picked,
    field(`${config.id}-title`, 'Title', title),
    note ? field(`${config.id}-note`, config.note.label, note) : null
  )

  return {
    id: config.id,
    el,
    directory: config.directory,
    setFiles,
    focus: () => input.focus(),
    collect () {
      if (files.length === 0) return { error: config.empty }
      const why = pickProblem(config.kind, files)
      if (why) return { error: why }
      const heading = title.value.trim()
      if (!heading) return { error: 'Give it a title.' }
      const request = { kind: config.kind, title: heading, files }
      if (note) request.note = note.value.trim()
      return { run: (actions) => actions.publishFiles(request) }
    },
    reset () {
      input.value = ''
      titleTouched = false
      title.value = ''
      if (note) note.value = ''
      setFiles([])
    }
  }
}

export const FILE_FORMS = [
  { id: 'picture', kind: 'picture', accept: 'image/*', multiple: false, directory: false, pick: 'Choose a picture', empty: 'Choose a picture first.', note: { label: 'Caption (optional)', placeholder: 'Shown under the picture' } },
  { id: 'files', kind: 'file', multiple: true, directory: false, pick: 'Choose files', empty: 'Choose at least one file first.', note: { label: 'Note (optional)', placeholder: 'Shown above the list of files' } },
  { id: 'folder', kind: 'folder', multiple: false, directory: true, pick: 'Choose a folder', empty: 'Choose a folder first.' },
  { id: 'website', kind: 'website', multiple: false, directory: true, pick: 'Choose a website folder', empty: 'Choose a website folder first.' }
]
