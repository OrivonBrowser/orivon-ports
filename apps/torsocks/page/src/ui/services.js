import { h, scrollToNode, setText } from './dom.js'
import { createServiceCard } from './service-card.js'
import { kindIcon } from './icons.js'

export function createServices (store, { onStart }) {
  const cards = new Map()
  let revealId = null
  let highlightTimer = 0

  const count = h('span', { class: 'count mono' })
  const list = h('div', { class: 'service-list' })
  const start = h('button', { type: 'button', class: 'btn btn-primary' }, 'Publish something')
  start.addEventListener('click', onStart)
  const empty = h('div', { class: 'empty', hidden: true },
    h('span', { class: 'empty-icon' }, kindIcon('website')),
    h('p', null, h('strong', null, 'Nothing is published yet.')),
    h('p', { class: 'muted' }, 'Write an article or share a picture, a file or a folder, and it appears here with its own .onion address.'),
    start
  )

  const el = h('section', { class: 'services', id: 'services', 'aria-labelledby': 'services-title' },
    h('div', { class: 'section-head' },
      h('h2', { id: 'services-title' }, 'Your onion services'),
      count
    ),
    h('p', { class: 'muted small' }, 'A new service can take a few minutes before Tor can find it. TorSocks tests each one through Tor by itself and says Online once it answers. Each keeps its address across restarts.'),
    empty,
    list
  )

  function tryReveal () {
    if (!revealId) return
    const card = cards.get(revealId)
    if (!card) return
    revealId = null
    scrollToNode(card.el)
    card.el.classList.add('is-new')
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => card.el.classList.remove('is-new'), 4500)
  }

  return {
    el,
    /** Scrolls to a service and highlights it as soon as it is in the list. */
    reveal (id) {
      revealId = id
      tryReveal()
    },
    update (state) {
      const ids = new Set(state.services.map((service) => service.id))
      for (const [id, card] of cards) {
        if (!ids.has(id)) {
          card.el.remove()
          cards.delete(id)
        }
      }
      state.services.forEach((service, index) => {
        let card = cards.get(service.id)
        if (!card) {
          card = createServiceCard(service, store.actions)
          cards.set(service.id, card)
        } else {
          card.update(service)
        }
        if (list.children[index] !== card.el) list.insertBefore(card.el, list.children[index] || null)
      })
      empty.hidden = state.services.length > 0
      setText(count, state.services.length ? String(state.services.length) : '')
      tryReveal()
    }
  }
}
