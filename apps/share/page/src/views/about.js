// About: how Share works in five points, what the services it uses can see, and which version this is.

import * as engine from '../engine.js'
import { h, replace } from '../dom.js'

const SOURCE = 'https://github.com/OrivonBrowser/orivon-ports/tree/main/apps/share'
const REPORT = 'https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Orivon%20Share'
const ORIVON = 'https://github.com/OrivonBrowser/orivon-mvp'

/** A JSON file this page ships beside itself, or null. @param {string} path */
async function ownFile (path) {
  try {
    const response = await fetch(path, { cache: 'no-cache' })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/** @param {HTMLElement} view @param {{ signal: AbortSignal }} ctx */
export async function renderAbout (view, ctx) {
  const [manifest, build] = await Promise.all([ownFile('.well-known/orivon.json'), ownFile('build.json')])
  if (ctx.signal.aborted) return
  const environment = engine.environment()
  const facts = [
    ['Version', typeof manifest?.version === 'string' ? manifest.version : 'not known here'],
    ['Encryption', typeof build?.typage === 'string' ? `age, through typage ${build.typage}` : 'age'],
    ['Address', 'share.orivonstack.eth'],
    ['Where it runs', environment.orivon ? 'In Orivon, as an app' : 'In this browser, as a page']
  ]
  replace(view,
    h('div', { class: 'page-head' },
      h('h1', {}, 'About Orivon Share'),
      h('p', { class: 'lead' }, 'Share files, folders and websites straight from your computer, with a password if you want one.')),
    h('section', { class: 'card', 'aria-label': 'How it works' },
      h('h2', {}, 'How it works'),
      h('ol', { class: 'about-list' },
        h('li', {}, h('strong', {}, 'It stays on your computer. '), 'A share is kept in this browser\'s storage and sent from there, straight to whoever opens the link, while Orivon Share is open. Orivon runs no server for it, and nobody keeps a copy unless you ask a service to.'),
        h('li', {}, h('strong', {}, 'Computers connect directly. '), 'Browsers connect to each other with WebRTC, which gets through most home routers with no setup. Public introduction servers only tell the two computers about each other, and address-discovery servers tell each its own address. They never see what is shared, only a fingerprint of it and IP addresses.'),
        h('li', {}, h('strong', {}, 'Every piece is checked. '), 'The share\'s IPFS address is worked out here, a fingerprint of exactly what you picked. Whoever opens the link checks each piece they receive against it, from a computer or from a gateway alike, so nobody on the way can swap anything.'),
        h('li', {}, h('strong', {}, 'A password locks it with age. '), 'A protected share is encrypted on your device with ',
          h('a', { href: 'https://age-encryption.org', target: '_blank', rel: 'noopener noreferrer' }, 'age'),
          ', with a key made from your password. It does not depend on this page: any program that reads age files opens it.'),
        h('li', {}, h('strong', {}, 'The source is open. '), h('a', { href: SOURCE, target: '_blank', rel: 'noopener noreferrer' }, 'Read how it is built'), '. The page asks for nothing from anyone but IPFS: no account, no analytics, no fonts or scripts from elsewhere.'))),
    h('section', { class: 'card', 'aria-label': 'When people cannot open a link' },
      h('h2', {}, 'When someone cannot open a link'),
      h('p', {}, 'A share is online only while Orivon Share is open on the computer that holds it. Two computers behind routers that both refuse direct connections cannot reach each other. Then keep the share with a pinning service (Settings, then My shares), or send the CAR file, which any IPFS node can import.'),
      environment.orivon ? h('p', { class: 'muted block' }, 'In Orivon, the page\'s own IPFS node can also serve a share to the whole IPFS network, directly when this computer can be reached from outside and otherwise through Orivon\'s relay.') : null),
    h('section', { class: 'card', 'aria-label': 'Opening a protected share without this page' },
      h('h2', {}, 'Opening a protected share without this page'),
      h('p', { class: 'muted' }, 'A protected share is a folder on IPFS with two files: share.age and HOW-TO-OPEN.txt. With any age program:'),
      h('pre', { class: 'commands' }, 'age -d -o share.zip share.age\nunzip share.zip'),
      h('p', { class: 'muted block' }, 'It asks for the password. What comes out is what was shared, plus a small file that says what it is.')),
    h('section', { class: 'card', 'aria-label': 'Privacy' },
      h('h2', {}, 'Privacy'),
      h('p', {}, 'The computers you share with see your IP address, as in any direct connection. Introduction servers, gateways and the services you add see your IP address and the address of what is shared or fetched. In Orivon, the page\'s IPFS node also keeps a place on Orivon\'s relay, which sees your IP address and that of whoever reaches you through it. None of them can read a protected share, and the relay stores nothing. Orivon Share keeps nothing about you on a server; what it remembers stays in this browser, and Settings can clear it.')),
    h('section', { class: 'card', 'aria-label': 'This build' },
      h('h2', {}, 'This build'),
      h('dl', { class: 'facts' }, facts.flatMap(([name, value]) => [h('dt', {}, name), h('dd', {}, value)])),
      h('p', { class: 'row block' },
        h('a', { href: REPORT, target: '_blank', rel: 'noopener noreferrer' }, 'Report a problem'), h('span', { class: 'muted' }, '·'),
        h('a', { href: ORIVON, target: '_blank', rel: 'noopener noreferrer' }, 'Orivon, the browser'))))
}
