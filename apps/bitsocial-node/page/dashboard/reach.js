// The reach screen: how people on the internet get to the node. The node's own word and the reason for it in a person's words, the
// circuits it gives out, the puts in flight, the bandwidth, and the relay a person can name (a multiaddr) with whether it holds a
// place for the node. Saving or removing the relay starts the node again, its data kept. It asks the node through `handle.reach`
// (`node/worker/reach-api.js`) and is not shown by a node that has none.

import { NOT_OFFERED, failure } from './board-section.js'
import { h } from './dom.js'
import { bytesOf, REACHABILITY } from './format.js'
import { nodeWords, reasonWords, RELAY_RESTART, RELAY_WHY } from './reach-words.js'

/** @param {{ totalIn: number, totalOut: number, rateIn: number, rateOut: number } | null} traffic */
const trafficWords = (traffic) => (traffic === null ? 'Not reported' : `In ${bytesOf(traffic.totalIn)} (${bytesOf(traffic.rateIn)}/s), out ${bytesOf(traffic.totalOut)} (${bytesOf(traffic.rateOut)}/s)`)

/** @param {{ pending: number, ok: number, retries: number, gaveUp: number } | null} puts */
const putsWords = (puts) => (puts === null ? 'Not reported' : `${String(puts.pending)} waiting, ${String(puts.ok)} sent, ${String(puts.retries)} tried again, ${String(puts.gaveUp)} given up`)

/** What the relay says of itself: named or not, and whether it holds a place. @param {{ address: string | null, holds: boolean, supported: boolean, source: string }} relay @param {boolean} answered */
function relayWords (relay, answered) {
  if (!relay.supported) return 'This build of the node takes no relay.'
  if (relay.address === null) return 'No relay is named.'
  if (!answered) return `${relay.address}: the node is starting again.`
  return relay.holds ? `${relay.address}: it holds a place for the node.` : `${relay.address}: it holds no place for the node yet. The node asks it after it starts, and this page checks again by itself.`
}

/**
 * @param {{ doc: Document, handle: any, classes: Record<string, string>, state: Record<string, any> }} context
 * `state` is what a test reads of the section: whether it is shown, the node's last answer, the last error.
 */
function createReach ({ doc, handle, classes, state }) {
  const at = (/** @type {string} */ role) => classes[role] ?? ''
  const element = h(doc, 'section', { class: at('section'), hidden: true, 'data-nd-section': 'reach' })
  const failed = h(doc, 'p', { class: at('error'), role: 'alert' })
  const cells = Object.fromEntries(['node', 'reach', 'why', 'peers', 'circuits', 'puts', 'traffic'].map((id) => [id, h(doc, 'dd', { 'data-nd-reach': id })]))
  const facts = h(doc, 'dl', { class: at('facts') },
    h(doc, 'dt', { text: 'Node' }), cells['node'], h(doc, 'dt', { text: 'Reachability' }), cells['reach'], h(doc, 'dt', { text: 'Why' }), cells['why'],
    h(doc, 'dt', { text: 'Connected peers' }), cells['peers'], h(doc, 'dt', { text: 'Relays holding a place for it' }), cells['circuits'],
    h(doc, 'dt', { text: 'Name records being sent' }), cells['puts'], h(doc, 'dt', { text: 'Traffic' }), cells['traffic'])
  const relayInput = h(doc, 'input', { class: at('input'), type: 'text', autocomplete: 'off', placeholder: '/dns4/relay.example.com/tcp/4001/p2p/12D3KooW...', 'data-nd-input': 'relay', on: { input: () => { typed = true; relayError.textContent = ''; say('') } } })
  const relayError = h(doc, 'span', { class: at('fieldError'), role: 'alert', 'data-nd-error': 'relay' })
  const relayLine = h(doc, 'p', { class: at('note'), 'data-nd-reach': 'relay' })
  const save = h(doc, 'button', { class: at('button'), type: 'submit', 'data-nd-action': 'save-relay', text: 'Save and restart the node' })
  const remove = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'remove-relay', text: 'Remove the relay and restart', on: { click: () => { removeRelay().catch(() => {}) } } })
  const message = h(doc, 'p', { class: at('formMessage'), role: 'status', 'data-nd-message': '' })
  const form = h(doc, 'form', { class: at('form'), novalidate: true, 'data-nd-form': 'reach-relay', on: { submit: (/** @type {any} */ event) => { event.preventDefault(); setRelay().catch(() => {}) } } },
    h(doc, 'div', { class: at('field'), 'data-nd-field': 'relay' }, h(doc, 'label', { class: at('label'), text: 'Relay address' }), h(doc, 'span', { class: at('control') }, relayInput), relayError),
    h(doc, 'p', { class: at('hint'), text: RELAY_RESTART }), message, h(doc, 'div', { class: at('actions') }, save, remove))
  let typed = false
  let busy = false
  let gone = false
  let refreshing = false

  element.append(
    h(doc, 'h2', { class: at('sectionTitle'), text: 'How your node is reached' }),
    h(doc, 'p', { class: at('note'), text: 'People on the internet fetch what your node holds only if they can connect to it. This is what the node knows of that now.' }),
    failed, facts,
    h(doc, 'h3', { class: at('sectionTitle'), text: 'A relay' }),
    h(doc, 'p', { class: at('note'), 'data-nd-reach': 'relay-why', text: RELAY_WHY }),
    relayLine, form)

  function say (/** @type {string} */ text, /** @type {boolean} */ bad = false) { message.textContent = text; message.setAttribute('data-nd-failed', bad ? 'true' : 'false') }

  /** @param {any} answer what the node says of how it is reached */
  function draw (answer) {
    state['reach'] = answer
    cells['node'].textContent = nodeWords(answer.node)
    cells['reach'].textContent = answer.answered ? REACHABILITY[/** @type {keyof typeof REACHABILITY} */ (answer.reachability)] ?? answer.reachability : 'Not known: the node did not answer'
    cells['reach'].setAttribute('data-nd-state', answer.answered ? answer.reachability : 'unknown')
    cells['why'].textContent = answer.answered ? reasonWords(answer.reason) : 'The node is starting or did not answer.'
    cells['peers'].textContent = answer.peers === null ? 'Not known' : String(answer.peers)
    cells['circuits'].textContent = answer.circuits.length === 0 ? 'None' : answer.circuits.map((/** @type {any} */ one) => `${one.relay}${one.named ? ' (the one you named)' : ''}`).join(', ')
    cells['puts'].textContent = putsWords(answer.puts)
    cells['traffic'].textContent = trafficWords(answer.bandwidth)
    relayLine.textContent = relayWords(answer.relay, answer.answered)
    relayLine.setAttribute('data-nd-holds', String(answer.relay.holds))
    if (!typed) relayInput.value = answer.relay.address ?? ''
    form.hidden = !answer.relay.supported
    remove.hidden = answer.relay.address === null
  }

  /** @param {() => Promise<any>} call @param {string} done */
  async function run (call, done) {
    if (busy) return
    busy = true
    save.disabled = remove.disabled = true
    try {
      draw(await call())
      typed = false
      relayInput.value = state['reach'].relay.address ?? ''
      say(done)
    } catch (error) {
      const { words } = failure(error)
      if (/relay/i.test(words)) relayError.textContent = words
      else say(words, true)
    } finally { busy = false; save.disabled = remove.disabled = false }
  }

  async function setRelay () {
    const relay = relayInput.value.trim()
    if (relay === '') { relayError.textContent = 'Type the relay address, or use Remove.'; return }
    await run(() => handle.reach('relay/set', { relay }), 'Saved. The node starts again with this relay.')
  }

  const removeRelay = () => run(() => handle.reach('relay/remove'), 'Removed. The node starts again without it.')

  /** Asks the node how it is reached and draws it. A node with no such calls hides the section for good. */
  async function refresh () {
    if (gone || refreshing || busy) return
    refreshing = true
    try {
      let answer
      try { answer = await handle.reach('state') } catch (error) {
        const { words, status } = failure(error)
        if (status !== null && NOT_OFFERED.includes(status)) { gone = true; state['shown'] = false; element.hidden = true; return }
        failed.textContent = `How the node is reached could not be read: ${words}`
        state['error'] = failed.textContent
        state['shown'] = true
        element.hidden = false
        return
      }
      failed.textContent = ''
      state['error'] = null
      state['shown'] = true
      element.hidden = false
      draw(answer)
    } finally { refreshing = false }
  }

  return { element, refresh }
}

/** The section: offered when the app names `reach` and the handle can make a reach call. */
export const reach = {
  name: 'reach',
  feature: 'reach',
  /** @param {Parameters<typeof createReach>[0]} context */
  mount: (context) => (typeof context.handle?.reach === 'function' ? createReach(context) : null)
}
