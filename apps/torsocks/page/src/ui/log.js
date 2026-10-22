import { h, setText } from './dom.js'
import { filterLogs, formatClock } from './helpers.js'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' }
]

function lineNode (line) {
  return h('div', { class: `log-line level-${line.level.toLowerCase()}` },
    h('span', { class: 'log-time' }, formatClock(line.time)),
    h('span', { class: 'log-level' }, line.level),
    h('span', { class: 'log-target' }, line.target),
    h('span', { class: 'log-msg' }, line.msg)
  )
}

export function createLog () {
  let level = 'all'
  let open = false
  let shown = []
  let latest = []

  const toggle = h('button', { type: 'button', class: 'log-toggle', 'aria-expanded': 'false', 'aria-controls': 'log-body' },
    h('span', { class: 'chevron', 'aria-hidden': 'true' }),
    h('span', { class: 'log-title' }, 'Log'),
    h('span', { class: 'count mono' })
  )
  const count = toggle.querySelector('.count')
  const filters = FILTERS.map((filter) => h('button', { type: 'button', class: 'seg', 'aria-pressed': filter.id === level ? 'true' : 'false' }, filter.label))
  const filterBar = h('div', { class: 'seg-group', role: 'group', 'aria-label': 'Log level', hidden: true }, filters)
  const view = h('div', { class: 'log-view mono', tabindex: '0', role: 'log', 'aria-label': 'Tor log' })
  const body = h('div', { class: 'log-body', id: 'log-body', hidden: true }, view)

  function rebuild (lines) {
    view.replaceChildren(...lines.map(lineNode))
    if (lines.length === 0) view.append(h('div', { class: 'log-empty' }, 'Nothing here yet.'))
    shown = lines
  }

  function render () {
    if (!open) return
    const lines = filterLogs(latest, level)
    const stuck = view.scrollTop + view.clientHeight >= view.scrollHeight - 24
    // The core appends and drops the oldest, so what is drawn is normally a window onto the new lines.
    const offset = shown.length > 0 && lines.length > 0 ? shown.indexOf(lines[0]) : -1
    const kept = offset >= 0 ? shown.slice(offset) : []
    if (offset >= 0 && kept.length <= lines.length && kept.every((line, i) => line === lines[i])) {
      for (let i = 0; i < offset; i++) view.firstChild.remove()
      for (const line of lines.slice(kept.length)) view.append(lineNode(line))
      shown = lines
    } else {
      rebuild(lines)
    }
    if (stuck) view.scrollTop = view.scrollHeight
  }

  toggle.addEventListener('click', () => {
    open = !open
    toggle.setAttribute('aria-expanded', String(open))
    body.hidden = !open
    filterBar.hidden = !open
    shown = []
    render()
    if (open) view.scrollTop = view.scrollHeight
  })
  filters.forEach((button, i) => {
    button.addEventListener('click', () => {
      level = FILTERS[i].id
      filters.forEach((other, j) => other.setAttribute('aria-pressed', String(j === i)))
      shown = []
      render()
      view.scrollTop = view.scrollHeight
    })
  })

  const el = h('section', { class: 'card log', 'aria-label': 'Log' }, h('div', { class: 'log-head' }, toggle, filterBar), body)
  return {
    el,
    update (state) {
      latest = state.logs
      setText(count, latest.length ? String(latest.length) : '')
      render()
    }
  }
}
