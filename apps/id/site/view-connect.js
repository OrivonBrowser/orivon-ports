// The screens a Web3site sends a person to. The arrival names who is asking and waits for Continue; Continue makes a challenge
// and goes to the bridge page of that site, which brings the person back with the request it kept. Only a person who came back
// that way, with the challenge this tab made, sees the consent screen: who is asking as the largest thing on the page, the address
// that would sign, the IDs it would name, and what the sign-in lets the site do. Then it signs one message and goes to the
// bridge, or goes back without signing. The only ways back to the site that are not the answer come from `exit`.

import { signIn, startChallenge, takeChallenge } from './connect-request.js'
import { connectEntry, consentView, lifetimeChoices, signInFailure } from './connect-model.js'
import { el, fill } from './dom.js'
import { icon } from './icons.js'
import { listIds } from './ids-list.js'
import { rememberIds } from './known-ids.js'
import { endedAhead } from './me-model.js'
import { addressCode, button, notice, working } from './parts.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { registerThenHash } from './router.js'
import { nameOf, records } from './sdk/orivonid.js'
import { arrivalHash, MAX_NAMES, NOT_BEFORE_KEY } from './sdk/protocol.js'
import { addIdSection, coverageNotice, lapsedSection } from './view-known.js'

/** @typedef {import('./app.js').App} App */

/**
 * The head of the sheet every sign-in screen is: a globe for the site that is asking, which is only what the link says it is,
 * or an alert where the request cannot be used, then who is asking as the heading, in Orivon's own type, and one line beneath it.
 * @param {'globe' | 'alert'} mark
 * @param {string | null} eyebrow
 * @param {HTMLElement} heading
 * @param {string | null} line
 */
function sheetHead (mark, eyebrow, heading, line) {
  return el('header', { class: 'sheet-head', 'data-mark': mark },
    el('span', { class: 'sheet-mark', 'aria-hidden': 'true' }, icon(mark, { size: 22 })),
    el('div', { class: 'sheet-title' },
      eyebrow === null ? null : el('p', { class: 'eyebrow', text: eyebrow }), heading,
      line === null ? null : el('p', { class: 'muted', text: line })))
}

/**
 * @param {HTMLElement} root
 * @param {App} app
 * @param {import('./router.js').Route} route
 */
export function mountConnect (root, app, route) {
  const entry = connectEntry({
    hash: route.hash, referrer: document.referrer, framed: window.top !== window, now: app.now(),
    challenges: { take: () => takeChallenge(app.tabStorage) }
  })
  if (entry.kind === 'arrive') {
    root.append(arriveScreen(app, entry))
    return { unmount () {} }
  }
  if (entry.kind !== 'consent') {
    root.append(entry.kind === 'invalid' ? invalidScreen(entry) : stoppedScreen(entry))
    return { unmount () {} }
  }
  const { request, exit } = entry
  const audience = el('h1', { class: 'audience', text: request.origin })
  const body = el('div', { class: 'connect-body' })
  root.append(el('div', { class: 'page narrow connect sheet' },
    sheetHead('globe', 'Sign in to', audience, 'Check that this is the site you meant to sign in to.'),
    body))

  let alive = true
  /** @type {Set<string>} */
  const ticked = new Set()
  let lifetime = request.ttl ?? 0
  let address = ''
  /** @type {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }[]} */
  let names = []
  /** @type {import('./ids-list.js').Found['lapsed']} */
  let lapsed = []
  /** @type {import('./sdk/orivonid.js').Coverage | null} */
  let coverage = null
  /** The IDs whose sign-ins were just ended, by the end time on their record. @type {Map<string, number>} */
  const endedUntil = new Map()
  let signing = false
  let failure = ''
  let retry = true

  const cancel = () => app.replace(exit)

  async function load () {
    if (app.chain === null) {
      fill(body, notice('warn', 'No wallet found', el('p', { text: 'Open this page in Orivon, or in a Chromium-based browser with an Ethereum wallet extension.' })), cancelRow())
      return
    }
    fill(body, working('Waiting for your wallet to share your address…'))
    const connected = app.session.address ?? await app.connect()
    if (!alive) return
    if (connected === null) {
      fill(body, notice('warn', app.session.failure ?? 'Orivon ID needs your address to sign you in.'),
        el('div', { class: 'actions' }, button('Connect', { primary: true, onClick: () => { void load() } }), button('Cancel', { quiet: true, onClick: cancel })))
      return
    }
    address = connected
    fill(body, working('Reading the IDs your address holds…'))
    try {
      await relist(app.chain)
      if (!alive) return
      for (const one of names) if (one.attribution.ok && !endedUntil.has(one.label)) ticked.add(one.label)
      if (request.key !== null) lifetime = lifetimeChoices(request).at(-1)?.seconds ?? lifetime
      draw()
    } catch (error) {
      if (!alive) return
      fill(body, notice('bad', REASONS[reasonOfError(error).reason]?.words ?? 'The IDs could not be read.'),
        el('div', { class: 'actions' }, button('Try again', { primary: true, onClick: () => { void load() } }), button('Cancel', { quiet: true, onClick: cancel })))
    }
  }

  /** Reads the list again, and which of its IDs had their sign-ins just ended. @param {NonNullable<App['chain']>} chain */
  async function relist (chain) {
    const found = await listIds(app, address)
    if (!alive) return
    names = found.names
    lapsed = found.lapsed
    coverage = found.coverage
    endedUntil.clear()
    for (const one of names) await readEnd(chain, one)
  }

  /** An ID the person added by name joins the list, ticked when it can sign in; the choices already made stay. @param {string} label */
  async function added (label) {
    if (app.chain === null) return
    await relist(app.chain)
    if (!alive) return
    const one = names.find((each) => each.label === label)
    if (one !== undefined && one.attribution.ok && !endedUntil.has(label)) ticked.add(label)
    draw()
  }

  /** The parts that deal with an ID the page may not have found itself. */
  const knownParts = () => [
    coverage === null ? null : coverageNotice(coverage),
    lapsedSection(app, address, lapsed, (label) => { lapsed = lapsed.filter((one) => one.label !== label) }),
    addIdSection(app, address, { listed: () => new Set(names.map((each) => each.label)), added })
  ]

  /**
   * An ID that can sign in may have had its sign-ins ended a moment ago: its record says until when. The site signed in to
   * reads the record again, so a read that failed only leaves the ID offered.
   * @param {NonNullable<App['chain']>} chain
   * @param {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }} one
   */
  async function readEnd (chain, one) {
    if (!one.attribution.ok) return
    try {
      const found = await records(chain, one.label, [NOT_BEFORE_KEY])
      const ended = endedAhead(found.texts[NOT_BEFORE_KEY], app.now())
      if (ended !== null) endedUntil.set(one.label, ended.seconds)
    } catch {
      // Nothing is known of an end, so the ID is offered, as before.
    }
  }

  const cancelRow = () => el('div', { class: 'actions' }, button('Cancel', { quiet: true, onClick: cancel }))

  function idList (/** @type {ReturnType<typeof consentView>} */ view) {
    return el('fieldset', { class: 'ids-pick' },
      el('legend', { text: `IDs to share (${view.chosen} of ${view.shareable.length} chosen, at most ${MAX_NAMES})` }),
      view.shareable.map((one) => {
        const id = `pick-${one.label}`
        const box = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox', id, checked: ticked.has(one.label), disabled: signing }))
        box.addEventListener('change', () => { if (box.checked) ticked.add(one.label); else ticked.delete(one.label); draw() })
        return el('div', { class: 'pick' }, box,
          el('label', { for: id }, el('span', { class: 'id-label', text: one.label }), el('span', { class: 'id-suffix', text: nameOf(one.label).slice(one.label.length) })))
      }))
  }

  /** The IDs the address holds that cannot sign in, apart from the ones that can, each with why and what to do. @param {ReturnType<typeof consentView>} view */
  function notOfferedList (view) {
    if (view.unusable.length === 0) return null
    return el('section', { class: 'not-offered', 'aria-labelledby': 'not-offered-title' },
      el('h2', { id: 'not-offered-title', text: 'IDs that cannot sign in yet' }),
      el('ul', {}, view.unusable.map((one) => el('li', {},
        el('p', { class: 'name-off', text: one.name }),
        el('p', { class: 'muted', text: one.words }),
        one.remedy === null ? null : el('p', { text: one.remedy }),
        one.link === null ? null : el('a', { href: one.link.href, text: one.link.label })))))
  }

  function lifetimeBlock () {
    if (request.key === null) return null
    return el('fieldset', { class: 'lifetime' },
      el('legend', { text: 'How long the site may act as these IDs' }),
      el('div', { class: 'choices' }, lifetimeChoices(request).map((choice) => {
        const id = `life-${choice.seconds}`
        const radio = /** @type {HTMLInputElement} */ (el('input', { type: 'radio', name: 'lifetime', id, value: String(choice.seconds), checked: choice.seconds === lifetime, disabled: signing }))
        radio.addEventListener('change', () => { lifetime = choice.seconds; draw() })
        return el('div', { class: 'choice' }, radio, el('label', { for: id, text: choice.label }))
      })))
  }

  async function approve () {
    const view = consentView({ request, names, ticked, lifetime, now: app.now(), endedUntil })
    if (!view.canSignIn || app.chain === null) return
    signing = true
    failure = ''
    draw()
    try {
      const { url } = await signIn({ request, chain: app.chain, address, labels: [...ticked], now: app.now(), ...(request.key === null ? {} : { lifetime: view.seconds }) })
      rememberIds(app.store, address, [...ticked])
      fill(body, notice('ok', `Signed. Going back to ${request.origin}…`))
      app.replace(url)
    } catch (error) {
      const found = signInFailure(error)
      failure = found.words
      retry = found.retry
      signing = false
      draw()
    }
  }

  function draw () {
    const focused = document.activeElement?.id ?? ''
    paint()
    if (focused !== '') document.getElementById(focused)?.focus()
  }

  function paint () {
    const view = consentView({ request, names, ticked, lifetime, now: app.now(), endedUntil })
    if (view.shareable.length === 0) {
      const justEnded = view.unusable.length > 0 && view.unusable.every((one) => one.reason === 'ended')
      const unseen = coverage?.complete === false
      fill(body, addressSection(),
        justEnded
          ? notice('info', 'Your sign-ins were just ended.', el('p', { text: 'A new sign-in works after the time below. Then check again.' }))
          : notice('info', 'You do not hold an ID that can sign in.',
            el('p', { text: `Register one first${unseen ? ', or add one you hold by name below' : ''}. You will come back to this request afterwards.` })),
        notOfferedList(view),
        knownParts(),
        el('div', { class: 'actions' },
          justEnded
            ? button('Check again', { primary: true, onClick: () => { void load() } })
            : button('Register an ID', { primary: true, onClick: () => app.go(registerThenHash(arrivalHash(request.origin))) }),
          button('Cancel', { quiet: true, onClick: cancel })))
      return
    }
    fill(body, addressSection(), idList(view), lifetimeBlock(),
      el('section', { class: 'terms', 'aria-labelledby': 'terms-title' },
        el('h2', { id: 'terms-title', text: 'What signing in does' }),
        el('ul', {}, view.terms.map((line) => el('li', { text: line })))),
      notOfferedList(view), knownParts(),
      signing ? working('Waiting for your wallet to sign…') : null,
      failure === '' ? null : notice('bad', failure),
      !view.canSignIn && !signing ? el('p', { class: 'hint', role: 'status', text: view.tooMany ? `Choose at most ${MAX_NAMES} IDs.` : 'Choose at least one ID to share.' }) : null,
      el('div', { class: 'sign-bar' },
        el('p', { class: 'wallet-warning', text: view.walletWarning }),
        el('div', { class: 'actions' },
          button('Sign in', { primary: true, disabled: !view.canSignIn || signing || (failure !== '' && !retry), onClick: () => { void approve() } }),
          button('Cancel', { quiet: true, disabled: signing, onClick: cancel }))))
  }

  const addressSection = () => el('section', { class: 'who', 'aria-label': 'The address that signs' },
    el('p', { class: 'eyebrow', text: 'The address that signs' }),
    el('div', { class: 'who-row' }, icon('wallet', { size: 16 }), addressCode(address)))

  void load()
  return { unmount () { alive = false } }
}

/**
 * The first step: who is asking, and Continue. Continue makes the challenge and goes to the bridge page of that site, which
 * is the only way to the consent screen. Cancel tells the site's bridge page that the person cancelled.
 * @param {App} app
 * @param {Extract<ReturnType<typeof connectEntry>, { kind: 'arrive' }>} entry
 */
function arriveScreen (app, entry) {
  const status = el('div', { class: 'connect-body' })
  const go = () => {
    const started = startChallenge({ storage: app.tabStorage, audience: entry.audience, now: app.now(), random: (bytes) => globalThis.crypto.getRandomValues(bytes) })
    if (started === null) {
      fill(status, notice('bad', 'This tab would not keep the code that ties this sign-in to it, so the sign-in cannot start here. Nothing was signed and nothing was shared.'))
      return
    }
    fill(status, working(`Going to ${entry.audience} to read its request…`))
    app.replace(started.url)
  }
  return el('div', { class: 'page narrow connect sheet' },
    sheetHead('globe', 'Sign in to', el('h1', { class: 'audience', text: entry.audience }), 'Check that this is the site you meant to sign in to.'),
    el('p', {
      class: 'step-line',
      text: `Continue only if you just pressed Sign in on ${entry.audience}. This page then asks that site what it wants, and shows it to you before anything is signed.`
    }),
    status,
    el('div', { class: 'actions' },
      button('Continue', { primary: true, onClick: go }),
      button('Cancel', { quiet: true, onClick: () => app.replace(entry.exit) })))
}

/** The screen for a link that cannot be used: it says why, and offers no way back to the site that asked. @param {Extract<ReturnType<typeof connectEntry>, { kind: 'invalid' }>} entry */
function invalidScreen (entry) {
  return el('div', { class: 'page narrow sheet' },
    sheetHead('alert', null, el('h1', { text: 'This sign-in request cannot be used' }), null),
    notice('bad', entry.words),
    el('p', { class: 'step-line', text: 'Nothing was signed and nothing was shared.' }),
    el('div', { class: 'actions' }, el('a', { class: 'button primary', href: '#/', text: 'Open Orivon ID' })))
}

/** The screen for a sign-in that cannot continue here: it says why, and offers no way back to the site that asked. @param {Extract<ReturnType<typeof connectEntry>, { kind: 'stopped' }>} entry */
function stoppedScreen (entry) {
  return el('div', { class: 'page narrow sheet' },
    sheetHead('alert', null, el('h1', { text: 'This sign-in was stopped' }), null),
    notice('bad', entry.words),
    el('p', { class: 'step-line', text: 'Nothing was signed and nothing was shared.' }),
    el('div', { class: 'actions' }, el('a', { class: 'button primary', href: '#/', text: 'Open Orivon ID' })))
}
