// The consent screen a Web3site sends a person to. It first asks how the person arrived (connectEntry) and stops
// when that does not fit. Otherwise it shows who is asking, as the largest thing on the page, the address that would
// sign and the IDs it would name, and what the sign-in lets the site do; then it signs one message and goes back to
// the site, or goes back without signing. The only ways back to the site that are not the answer come from `exit`.

import { signIn } from './connect-request.js'
import { connectEntry, consentView, lifetimeChoices, signInFailure } from './connect-model.js'
import { el, fill } from './dom.js'
import { endedAhead } from './me-model.js'
import { addressCode, button, notice, working } from './parts.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { registerThenHash } from './router.js'
import { namesOf, nameOf, records } from './sdk/orivonid.js'
import { MAX_NAMES, NOT_BEFORE_KEY } from './sdk/protocol.js'

/** @typedef {import('./app.js').App} App */

/**
 * @param {HTMLElement} root
 * @param {App} app
 * @param {import('./router.js').Route} route
 */
export function mountConnect (root, app, route) {
  const entry = connectEntry({ hash: route.hash, referrer: document.referrer, framed: window.top !== window })
  if (entry.kind !== 'consent') {
    root.append(entry.kind === 'invalid' ? invalidScreen(app, entry) : stoppedScreen(entry))
    return { unmount () {} }
  }
  const { request, exit, warning, returnShown } = entry
  const audience = el('h1', { class: 'audience', text: request.origin })
  const body = el('div', { class: 'connect-body' })
  root.append(el('div', { class: 'page narrow connect' },
    el('p', { class: 'eyebrow', text: 'Sign in to' }), audience,
    el('p', { class: 'muted', text: 'Check that this is the site you meant to sign in to.' }),
    returnShown.full === null ? null : el('div', { class: 'return-full' },
      el('p', { class: 'eyebrow', text: 'Return address' }), el('code', { class: 'hex', text: returnShown.full }), el('p', { class: 'muted', text: returnShown.words ?? '' })),
    warning === null ? null : notice('warn', warning),
    body))

  let alive = true
  /** @type {Set<string>} */
  const ticked = new Set()
  let lifetime = request.ttl ?? 0
  let address = ''
  /** @type {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }[]} */
  let names = []
  /** The IDs whose sign-ins were just ended, by the end time on their record. @type {Map<string, number>} */
  const endedUntil = new Map()
  let signing = false
  let failure = ''
  let retry = true

  const cancel = () => app.leave(exit.url)

  async function load () {
    if (app.chain === null) {
      fill(body, notice('warn', 'No wallet found', el('p', { text: 'Open this page in Orivon, or in a browser with an Ethereum wallet extension.' })), cancelRow())
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
      const found = await namesOf(app.chain, address)
      if (!alive) return
      names = found.names
      endedUntil.clear()
      for (const one of names) await readEnd(app.chain, one)
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
        return el('div', { class: 'pick' }, box, el('label', { for: id, text: nameOf(one.label) }))
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
      fill(body, notice('ok', `Signed. Going back to ${request.origin}…`))
      app.leave(url)
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
      fill(body, addressSection(),
        justEnded
          ? notice('info', 'Your sign-ins were just ended.', el('p', { text: 'A new sign-in works after the time below. Then check again.' }))
          : notice('info', 'You do not hold an ID that can sign in.', el('p', { text: 'Register one first. You will come back to this request afterwards.' })),
        notOfferedList(view),
        el('div', { class: 'actions' },
          justEnded
            ? button('Check again', { primary: true, onClick: () => { void load() } })
            : button('Register an ID', { primary: true, onClick: () => app.go(registerThenHash(route.hash)) }),
          button('Cancel', { quiet: true, onClick: cancel })))
      return
    }
    fill(body, addressSection(), idList(view), notOfferedList(view), lifetimeBlock(),
      el('section', { class: 'terms', 'aria-labelledby': 'terms-title' },
        el('h2', { id: 'terms-title', text: 'What signing in does' }),
        el('ul', {}, view.terms.map((line) => el('li', { text: line })))),
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
    el('p', { class: 'eyebrow', text: 'The address that signs' }), addressCode(address))

  void load()
  return { unmount () { alive = false } }
}

/**
 * @param {App} app
 * @param {Extract<ReturnType<typeof connectEntry>, { kind: 'invalid' }>} entry
 */
function invalidScreen (app, entry) {
  const { exit, returnOrigin } = entry
  return el('div', { class: 'page narrow' },
    el('h1', { text: 'This sign-in request cannot be used' }),
    notice('bad', entry.words),
    el('p', { text: 'Nothing was signed and nothing was shared.' }),
    exit === null
      ? [entry.note === null ? null : el('p', { class: 'muted', text: entry.note }), el('div', { class: 'actions' }, el('a', { class: 'button primary', href: '#/', text: 'Open Orivon ID' }))]
      : [
          el('p', { text: 'The request names this site as the place to go back to:' }),
          el('p', { class: 'audience small', text: returnOrigin }),
          el('div', { class: 'actions' }, button(`Go back to ${returnOrigin}`, { primary: true, onClick: () => app.leave(exit.url) }))
        ])
}

/** The screen for a sign-in that cannot start here: it says why, and offers no way back to the site that asked. @param {Extract<ReturnType<typeof connectEntry>, { kind: 'stopped' }>} entry */
function stoppedScreen (entry) {
  return el('div', { class: 'page narrow' },
    el('h1', { text: 'This sign-in was stopped' }),
    notice('bad', entry.words),
    el('p', { text: 'Nothing was signed and nothing was shared.' }),
    el('div', { class: 'actions' }, el('a', { class: 'button primary', href: '#/', text: 'Open Orivon ID' })))
}
