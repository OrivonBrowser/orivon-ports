import { h, setText, setTone } from './dom.js'
import { chipFor } from './helpers.js'

export function createTopbar () {
  const label = h('span', { class: 'chip-label' })
  const chip = h('div', { class: 'chip', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'chip-dot', 'aria-hidden': 'true' }), label)
  const arti = h('span', { class: 'arti mono' })
  const el = h('header', { class: 'topbar' },
    h('div', { class: 'wrap topbar-row' },
      h('div', { class: 'brand' },
        h('img', { src: 'assets/logo.svg', alt: '', width: 32, height: 32 }),
        h('span', { class: 'brand-name' }, 'TorSocks')
      ),
      h('div', { class: 'topbar-status' }, chip, arti)
    )
  )
  return {
    el,
    update (state) {
      const { text, tone } = chipFor(state)
      setText(label, text)
      setTone(chip, 'tone', tone)
      setText(arti, state.arti ? `Arti ${state.arti}` : '')
    }
  }
}
