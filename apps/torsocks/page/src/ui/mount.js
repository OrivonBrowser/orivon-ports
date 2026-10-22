import { h, scrollToNode } from './dom.js'
import { createTopbar } from './topbar.js'
import { createProxy } from './proxy.js'
import { createHowTo } from './howto.js'
import { createPublish } from './publish.js'
import { createServices } from './services.js'
import { createLog } from './log.js'
import { createFailedPanel, createOutsidePanel } from './notices.js'

/**
 * Draws TorSocks into `root` and keeps it in step with the store.
 * Every piece is built once and then updated in place.
 * @param {HTMLElement} root
 * @param {{ getState(): any, subscribe(fn: (state: any) => void): () => void, actions: any }} store
 * @returns {() => void} stops listening
 */
export function mountUi (root, store) {
  const topbar = createTopbar()
  const failed = createFailedPanel(store)
  const outside = createOutsidePanel()
  const proxy = createProxy(store)
  const howto = createHowTo()
  const services = createServices(store, {
    onStart () {
      scrollToNode(publish.el)
      publish.focus()
    }
  })
  const publish = createPublish(store, { onPublished: (id) => services.reveal(id) })
  const log = createLog()

  const hero = h('section', { class: 'hero' },
    h('h1', null, 'Tor, from inside your browser.'),
    h('p', null, 'TorSocks gives this computer a Tor SOCKS5 proxy, so Orivon can open .onion sites. It also publishes your articles, pictures, files and websites on .onion addresses of their own.')
  )
  const top = h('div', { class: 'grid-top' }, proxy.el, howto.el)
  const footer = h('footer', { class: 'footer' },
    h('div', { class: 'wrap' }, h('p', null, 'Built on Arti, the Tor Project\'s Tor implementation in Rust. TorSocks is not made or endorsed by the Tor Project.'))
  )

  const parts = [top, publish.el, services.el]
  root.replaceChildren(
    h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
    topbar.el,
    h('main', { class: 'wrap main', id: 'main', tabindex: '-1' }, hero, failed.el, outside.el, ...parts, log.el),
    footer
  )

  function render (state) {
    topbar.update(state)
    failed.update(state)
    outside.update(state)
    const controls = state.phase === 'checking' || state.phase === 'starting' || state.phase === 'running'
    for (const part of parts) part.hidden = !controls
    log.el.hidden = state.phase === 'outside-orivon'
    if (controls) {
      proxy.update(state)
      publish.update(state)
      services.update(state)
    }
    log.update(state)
  }

  render(store.getState())
  return store.subscribe(render)
}
