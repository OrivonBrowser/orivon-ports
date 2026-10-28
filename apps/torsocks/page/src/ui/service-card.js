import { copyButton, h, setAttr, setText, setTone } from './dom.js'
import { kindIcon } from './icons.js'
import { formatDate, groupOnion, humanSize, KIND_LABELS, serviceStatus } from './helpers.js'

function stat (label) {
  const value = h('dd', { class: 'mono' })
  return { el: h('div', { class: 'stat' }, h('dt', null, label), value), value }
}

/** One onion service. Built once per id and updated in place. */
export function createServiceCard (initial, actions) {
  let id = initial.id
  let current = initial
  let shownOnion = null

  const title = h('h3', { class: 'svc-title' })
  const meta = h('p', { class: 'svc-meta muted' })
  const badge = h('span', { class: 'badge' })
  const badgeLabel = h('span')
  badge.append(h('span', { class: 'badge-dot', 'aria-hidden': 'true' }), badgeLabel)
  const glyph = h('span', { class: 'glyph' }, kindIcon(initial.kind))

  const onion = h('code', { class: 'onion' })
  const announce = h('span', { class: 'sr-only', 'aria-live': 'polite' })
  const copy = copyButton('Copy', () => current.onion || '', (text) => setText(announce, text))
  const open = h('a', { class: 'btn btn-ghost btn-small', target: '_blank', rel: 'noreferrer' }, 'Open')

  const hits = stat('Visits')
  const files = stat('Files')
  const size = stat('Size')
  const problem = h('p', { class: 'problem small', hidden: true })

  const check = h('p', { class: 'check small', 'aria-live': 'polite', hidden: true })
  const message = h('p', { class: 'msg msg-bad small', 'aria-live': 'polite', hidden: true })

  const power = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false' },
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
    h('span', { class: 'switch-label' })
  )
  const powerLabel = power.querySelector('.switch-label')
  const test = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, 'Test')
  const remove = h('button', { type: 'button', class: 'btn btn-danger-ghost btn-small' }, 'Delete')
  const keep = h('button', { type: 'button', class: 'btn btn-ghost btn-small' }, 'Keep it')
  const confirmRemove = h('button', { type: 'button', class: 'btn btn-danger btn-small' }, 'Delete for good')
  const confirm = h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm delete', hidden: true },
    h('p', { class: 'small' }, 'Delete this service? Its address is gone for good: nobody can ever publish at it again.'),
    h('div', { class: 'row' }, confirmRemove, keep)
  )
  const controls = h('div', { class: 'svc-actions' }, power, test, remove)

  let busy = false
  async function run (work, fallback) {
    if (busy) return
    busy = true
    message.hidden = true
    sync()
    try {
      await work()
    } catch (error) {
      setText(message, error && error.message ? error.message : fallback)
      message.hidden = false
    } finally {
      busy = false
      sync()
    }
  }

  power.addEventListener('click', () => run(() => actions.setEnabled(id, !current.enabled), 'Could not change that.'))
  test.addEventListener('click', () => {
    message.hidden = true
    actions.check(id)
  })
  remove.addEventListener('click', () => {
    controls.hidden = true
    confirm.hidden = false
    keep.focus()
  })
  keep.addEventListener('click', () => {
    confirm.hidden = true
    controls.hidden = false
    remove.focus()
  })
  confirmRemove.addEventListener('click', () => run(() => actions.remove(id), 'Could not delete it.'))

  const el = h('article', { class: 'card service', 'data-id': id },
    h('div', { class: 'svc-head' }, glyph, h('div', { class: 'svc-id' }, title, meta), badge),
    h('div', { class: 'onion-row' }, onion, h('div', { class: 'row' }, copy, open), announce),
    h('dl', { class: 'stats stats-inline' }, hits.el, files.el, size.el),
    problem,
    check,
    controls,
    confirm,
    message
  )

  function sync () {
    const service = current
    const label = service.enabled ? 'Online' : 'Offline'
    setText(powerLabel, label)
    setAttr(power, 'aria-checked', String(service.enabled))
    power.setAttribute('aria-label', `${label}: ${service.title}`)
    power.disabled = busy
    confirmRemove.disabled = busy
    keep.disabled = busy
    const pending = Boolean(service.check && service.check.pending)
    test.disabled = !service.onion || !service.enabled || pending
    setText(test, pending ? 'Testing…' : 'Test')
  }

  function update (service) {
    current = service
    id = service.id
    setText(title, service.title)
    const date = formatDate(service.created)
    setText(meta, `${KIND_LABELS[service.kind] || service.kind}${date ? `, created ${date}` : ''}`)

    const { badge: { text, tone, pulse }, note, detail } = serviceStatus(service)
    setText(badgeLabel, text)
    setTone(badge, 'tone', tone)
    badge.classList.toggle('is-pulsing', pulse)

    if (service.onion !== shownOnion) {
      shownOnion = service.onion
      const { groups, suffix } = groupOnion(service.onion)
      onion.replaceChildren(...groups.map((group) => h('span', { class: 'onion-group' }, group)), groups.length ? h('span', { class: 'onion-suffix' }, suffix) : h('span', { class: 'muted' }, 'Address pending…'))
      onion.setAttribute('aria-label', service.onion || 'Address pending')
    }
    copy.disabled = !service.onion
    const url = service.onion ? actions.visitUrl(service.id) : ''
    setAttr(open, 'href', url || null)
    setAttr(open, 'aria-disabled', url ? null : 'true')
    open.classList.toggle('is-disabled', !url)
    setAttr(open, 'aria-label', `Open ${service.title} in a new tab`)

    setText(hits.value, service.hits.toLocaleString('en-US'))
    setText(files.value, service.files.toLocaleString('en-US'))
    setText(size.value, humanSize(service.bytes))

    problem.hidden = note === ''
    setText(problem, note)
    problem.classList.toggle('is-note', tone === 'ok' || tone === 'busy')
    setAttr(problem, 'title', detail !== '' && detail !== note ? `Tor says: ${detail}` : null)

    // A test the page ran by itself that found nothing yet is explained by the note above, not shown as an error.
    const result = service.check && !(service.check.auto && !service.check.pending && !service.check.ok) ? service.check : null
    check.hidden = !result
    if (result) {
      check.classList.toggle('is-pending', result.pending)
      check.classList.toggle('is-ok', !result.pending && result.ok)
      check.classList.toggle('is-bad', !result.pending && !result.ok)
      setText(check, result.pending ? 'Testing through Tor…' : `${result.text}${result.ms > 0 ? ` (${result.ms} ms)` : ''}`)
    }
    el.classList.toggle('is-off', !service.enabled)
    // What Arti said and whether a test through Tor passed: read by a person debugging, and by the drives.
    setAttr(el, 'data-state', service.state)
    setAttr(el, 'data-reached', String(service.reached))
    sync()
  }

  update(initial)
  return { el, update, id: () => id }
}
