import { h } from './dom.js'

export function createHowTo () {
  const step = (...children) => h('li', null, ...children)
  return {
    el: h('section', { class: 'card howto', 'aria-labelledby': 'howto-title' },
      h('h2', { id: 'howto-title' }, 'Use it in Orivon'),
      h('ol', { class: 'steps' },
        step(h('p', null, 'Copy the address above.')),
        step(h('p', null, 'Open Orivon\'s Settings, then Tunnels, and paste it into "SOCKS5 address" under "Your proxy".')),
        step(
          h('p', null, 'Open any .onion address. If it does not load, click the tunnel button in the address bar and choose "Your proxy" for that site.'),
          h('p', { class: 'muted' }, 'To send everything through Tor instead, set "Default tunnel" to your proxy and turn on "Send all of Orivon\'s traffic through the default tunnel".')
        )
      ),
      h('p', { class: 'msg msg-warn' }, 'TorSocks is the proxy, so keep it out of the tunnel: if you send everything through your proxy, open TorSocks\' own tunnel button and choose Off.'),
      h('p', { class: 'muted small' }, 'The proxy runs while a TorSocks tab is open.')
    ),
    update () {}
  }
}
