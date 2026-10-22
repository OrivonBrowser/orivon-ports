import { h, setText } from './dom.js'

/** A Restart button that reports a restart which itself fails. */
export function createRestartControl (store) {
  const message = h('p', { class: 'msg msg-bad', 'aria-live': 'polite', hidden: true })
  const button = h('button', { type: 'button', class: 'btn btn-primary' }, 'Restart')
  button.addEventListener('click', async () => {
    button.disabled = true
    button.textContent = 'Restarting…'
    message.hidden = true
    try {
      await store.actions.restart()
    } catch (error) {
      setText(message, error && error.message ? error.message : 'Could not restart.')
      message.hidden = false
    } finally {
      button.disabled = false
      button.textContent = 'Restart'
    }
  })
  return { el: h('div', { class: 'restart' }, button, message) }
}

/** Shown when the daemon stopped or never started. */
export function createFailedPanel (store) {
  const detail = h('p', { class: 'failed-detail mono' })
  const restart = createRestartControl(store)
  const el = h('section', { class: 'card notice notice-bad', 'aria-labelledby': 'failed-title', role: 'alert', hidden: true },
    h('h2', { id: 'failed-title' }, 'Tor is not running'),
    h('p', null, 'TorSocks could not keep Tor running. Your proxy and your onion services are offline until it starts again.'),
    detail,
    restart.el
  )
  return {
    el,
    update (state) {
      el.hidden = state.phase !== 'failed'
      setText(detail, state.error || 'No reason was given.')
    }
  }
}

/** Replaces the controls when the page is open in an ordinary browser. */
export function createOutsidePanel () {
  const el = h('section', { class: 'card notice notice-idle', 'aria-labelledby': 'outside-title', hidden: true },
    h('h2', { id: 'outside-title' }, 'Open TorSocks in Orivon Browser'),
    h('p', null, 'TorSocks runs Tor on your computer, and a web page cannot do that on its own. It needs Orivon\'s sockets to reach the Tor network and Orivon\'s files to keep your onion services and their addresses.'),
    h('p', null, 'In another browser the controls would do nothing, so they are left out. Open this page in Orivon Browser and TorSocks starts by itself.'),
    h('ul', { class: 'plain-list' },
      h('li', null, 'A SOCKS5 proxy for .onion sites, on 127.0.0.1.'),
      h('li', null, 'Articles, pictures, files and websites on their own .onion addresses.')
    )
  )
  return { el, update (state) { el.hidden = state.phase !== 'outside-orivon' } }
}
