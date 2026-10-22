import { copyButton, h, setAttr, setText } from './dom.js'
import { createCircuit } from './circuit.js'
import { createRestartControl } from './notices.js'
import { formatSocks, percent } from './helpers.js'

function stat (label) {
  const value = h('dd', { class: 'mono' }, '0')
  return { el: h('div', { class: 'stat' }, h('dt', null, label), value), value }
}

export function createProxy (store) {
  const circuit = createCircuit()
  const address = h('code', { class: 'socks-address', id: 'socks-address' })
  const announce = h('span', { class: 'sr-only', 'aria-live': 'polite' })
  const copy = copyButton('Copy', () => formatSocks(store.getState().socks), (text) => setText(announce, text))
  copy.classList.replace('btn-ghost', 'btn-primary')
  copy.classList.remove('btn-small')
  copy.setAttribute('aria-describedby', 'socks-address')

  const percentText = h('span', { class: 'mono progress-value' }, '0%')
  const bar = h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Tor connection', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, h('span', { class: 'bar-fill' }))
  const barFill = bar.firstChild
  const message = h('p', { class: 'bootstrap-msg mono' })
  const blocked = h('p', { class: 'msg msg-warn', role: 'status', hidden: true })

  const socksFailed = h('div', { class: 'notice-inline notice-bad', role: 'alert', hidden: true },
    h('strong', null, 'The proxy could not start'),
    h('p', { class: 'mono' })
  )
  const socksFailedText = socksFailed.querySelector('p')
  socksFailed.append(createRestartControl(store).el)

  const open = stat('Open connections')
  const total = stat('Connections so far')

  const el = h('section', { class: 'card proxy', 'aria-labelledby': 'proxy-title' },
    h('div', { class: 'card-head' },
      h('div', null,
        h('h2', { id: 'proxy-title' }, 'Tor proxy'),
        h('p', { class: 'muted' }, 'SOCKS5, on this computer only')
      ),
      circuit.el
    ),
    h('div', { class: 'address-row' }, address, copy, announce),
    h('div', { class: 'progress' },
      h('div', { class: 'progress-head' }, h('span', { class: 'label' }, 'Tor connection'), percentText),
      bar,
      message,
      blocked
    ),
    socksFailed,
    h('dl', { class: 'stats' }, open.el, total.el)
  )

  return {
    el,
    update (state) {
      const text = formatSocks(state.socks)
      const waiting = state.phase === 'running' ? 'Opening the proxy…' : 'Starting…'
      setText(address, text || waiting)
      address.classList.toggle('is-placeholder', !text)
      copy.disabled = !text

      const pct = percent(state.bootstrap.frac)
      setText(percentText, `${pct}%`)
      barFill.style.width = `${pct}%`
      setAttr(bar, 'aria-valuenow', pct)
      bar.classList.toggle('is-ready', Boolean(state.bootstrap.ready))
      setText(message, state.bootstrap.ready ? 'Tor is reachable. The proxy carries traffic.' : state.bootstrap.msg || '')
      circuit.update(state.bootstrap.ready ? 1 : state.bootstrap.frac, state.bootstrap.ready)

      const reason = state.bootstrap.blocked
      blocked.hidden = !reason
      setText(blocked, reason ? `Blocked: ${reason}` : '')

      const failed = state.phase === 'running' && state.socks.state === 'failed'
      socksFailed.hidden = !failed
      setText(socksFailedText, state.socks.msg || 'No reason was given.')

      setText(open.value, String(state.traffic.open))
      setText(total.value, String(state.traffic.total))
    }
  }
}
