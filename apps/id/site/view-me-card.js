// One ID on the My IDs page: its address, contenthash and text records as the chain gives them now, a form to change
// the text records where the holder can write them, the move to a resolver of the holder where it cannot, and the button
// that ends every sign-in made with it. Each change is one transaction the wallet signs.

import { el, fill } from './dom.js'
import { icon } from './icons.js'
import { changedTexts, COMMON_KEYS, contenthashView, endAvailability, endedAt, endSignInsWords, nameStatus, readKeys, signInsWords, writeKeys } from './me-model.js'
import { copyKeys, moveWords } from './move-model.js'
import { moveOffer } from './offer-model.js'
import { addressCode, button, copyButton, hexCode, notice, working } from './parts.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { serialPerAccount } from './register-flow.js'
import { recordsTx } from './register-tx.js'
import { ChainError } from './sdk/chain.js'
import { nameOf, records } from './sdk/orivonid.js'
import { NOT_BEFORE_KEY } from './sdk/protocol.js'
import { RevokeError, revokeAllCall } from './sdk/connect.js'
import { mountMove } from './view-me-move.js'

/** @typedef {import('./app.js').App} App */
/** @typedef {Awaited<ReturnType<typeof records>>} Records */

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

/** What a failed send means to the person. @param {unknown} error */
function sendFailure (error) {
  const found = reasonOfError(error)
  const words = REASONS[found.reason]?.words ?? found.detail
  const rights = found.reason === 'reverted' ? ' Your account may not be allowed to change this ID’s resolver.' : ''
  return { words: words + rights, hash: error instanceof ChainError && error.hash !== undefined ? error.hash : null, detail: found.detail }
}

/**
 * @param {HTMLElement} host
 * @param {App} app
 * @param {{ label: string, attribution: import('./sdk/orivonid.js').Attribution }} one
 * @param {string} address the connected address
 * @returns {() => Promise<void>} reads its records, settling once they are drawn; the card shows it is waiting until then
 */
export function mountCard (host, app, one, address) {
  const name = nameOf(one.label)
  const chain = /** @type {NonNullable<App['chain']>} */ (app.chain)
  /** What the chain said about the ID when it was listed, and again after a move. */
  let attributed = one.attribution
  let status = nameStatus(attributed)
  /** @type {Records | null} */
  let found = null
  let loadFailure = ''
  /** @type {'view' | 'edit' | 'end' | 'move'} */
  let mode = 'view'
  /** @type {import('./dom.js').Child} */
  let outcome = null
  let busy = ''
  /** Whether the button that ends all sign-ins is offered; null until `revokeAllCall` has been asked. @type {ReturnType<typeof endAvailability> | null} */
  let end = null
  /** @type {string[]} */
  let extraKeys = readKeys(app.store)
  const moveHost = el('div', { class: 'move-host' })
  /** @type {{ destroy: () => void } | null} */
  let moving = null

  const keysShown = () => [...new Set([...COMMON_KEYS, ...extraKeys])]

  /** Asks for the transaction before the button is drawn: it reads the chain and sends nothing. */
  async function askEnd () {
    try {
      await revokeAllCall(chain, one.label, app.now(), { holder: address })
      return endAvailability(one.label, null)
    } catch (error) {
      return endAvailability(one.label, error)
    }
  }

  async function load () {
    const asking = askEnd()
    try {
      found = await records(chain, one.label, [...keysShown(), NOT_BEFORE_KEY])
      loadFailure = ''
    } catch (error) {
      loadFailure = REASONS[reasonOfError(error).reason]?.words ?? 'The records could not be read.'
    }
    end = await asking
    render()
  }

  /** @param {{ to: string, data: Uint8Array }} call @param {string} done */
  async function submit (call, done) {
    mode = 'view'
    outcome = null
    busy = 'Waiting for your wallet to sign…'
    render()
    try {
      const hash = await serialPerAccount(address, async () => {
        const sent = await chain.sendTransaction({ from: address, to: call.to, data: call.data })
        busy = 'Sent. Waiting for a block…'
        render()
        const receipt = await chain.waitForReceipt(sent)
        if (receipt.status !== 1) throw new ChainError('reverted', 'the transaction was mined and reverted', { hash: sent })
        return sent
      })
      outcome = notice('ok', done, el('p', {}, el('span', { text: 'Transaction ' }), hexCode(hash)))
      busy = ''
      await load()
    } catch (error) {
      const failure = sendFailure(error)
      busy = ''
      outcome = notice('bad', failure.words,
        failure.hash === null ? null : el('p', {}, el('span', { text: 'Transaction ' }), hexCode(failure.hash)),
        el('details', { class: 'detail' }, el('summary', { text: 'Technical detail' }), el('pre', { text: failure.detail })))
      render()
    }
  }

  /** @param {HTMLFormElement} form */
  async function saveRecords (form) {
    if (found === null || found.resolver === null) return
    const edited = Object.fromEntries([...form.querySelectorAll('input[data-key]')].map((field) => [field.getAttribute('data-key') ?? '', /** @type {HTMLInputElement} */ (field).value]))
    const changed = changedTexts(found.texts, edited)
    if (Object.keys(changed).length === 0) { outcome = notice('info', 'Nothing changed.'); mode = 'view'; render(); return }
    extraKeys = [...new Set([...extraKeys, ...Object.keys(changed).filter((key) => !COMMON_KEYS.includes(key))])]
    writeKeys(app.store, extraKeys)
    await submit(recordsTx(found.resolver, one.label, address, changed), 'Records saved.')
  }

  async function endSignIns () {
    mode = 'view'
    busy = 'Preparing the transaction…'
    render()
    try {
      await submit(await revokeAllCall(chain, one.label, app.now(), { holder: address }), 'Every sign-in made so far with this ID has been ended. Signing in again works after five minutes.')
    } catch (error) {
      busy = ''
      if (error instanceof RevokeError) end = endAvailability(one.label, error)
      else outcome = notice('bad', sendFailure(error).words)
      render()
    }
  }

  function startMove () {
    mode = 'move'
    outcome = null
    moving = mountMove(moveHost, app, { label: one.label, address, keys: copyKeys(extraKeys), close: closeMove, finished: (done) => { void moved(done) } })
    render()
  }

  function closeMove () {
    moving?.destroy()
    moving = null
    moveHost.replaceChildren()
    mode = 'view'
    render()
  }

  /** The registry names the holder's resolver and the chain was read again: the status is what that read says. @param {Record<string, any>} done */
  async function moved (done) {
    closeMove()
    attributed = done['facts'].attribution
    status = nameStatus(attributed)
    const sent = Object.entries(/** @type {Record<string, string>} */ (done['hashes']))
    outcome = notice(status.ok ? 'ok' : 'warn',
      status.ok ? `${name} now points at your resolver and can sign you in.` : `${name} now points at your resolver, but it cannot sign you in yet.`,
      status.ok ? null : el('p', { text: status.why ?? '' }),
      el('p', { text: 'Every sign-in made with it before the move has ended.' }),
      sent.map(([step, hash]) => el('p', { class: 'step-hash' }, el('span', { text: `${step === 'deploy' ? 'Resolver' : step === 'records' ? 'Records' : 'Move'}: ` }), hexCode(hash))))
    found = null
    end = null
    render()
    await load()
  }

  /** @param {HTMLFormElement} form */
  function addField (form) {
    const entry = /** @type {HTMLInputElement} */ (form.querySelector('input[name="new-key"]'))
    const key = entry.value.trim()
    if (!KEY_PATTERN.test(key) || key === NOT_BEFORE_KEY || keysShown().includes(key)) {
      entry.setAttribute('aria-invalid', 'true')
      return
    }
    extraKeys = [...extraKeys, key]
    entry.value = ''
    entry.removeAttribute('aria-invalid')
    form.querySelector('.fields')?.append(field(key, ''))
  }

  /** @param {string} key @param {string} value */
  function field (key, value) {
    const id = `${one.label}-${key}`
    const input = /** @type {HTMLInputElement} */ (el('input', { id, type: 'text', 'data-key': key, autocomplete: 'off', spellcheck: 'false' }))
    input.value = value
    return el('div', { class: 'field' }, el('label', { for: id, text: key }), input)
  }

  function recordRows () {
    if (found === null) return null
    const set = Object.entries(found.texts).filter(([key, value]) => value !== null && key !== NOT_BEFORE_KEY)
    return set.length === 0
      ? el('p', { class: 'muted', text: 'No text records are set.' })
      : el('ul', { class: 'records' }, set.map(([key, value]) => el('li', {}, el('span', { class: 'record-key', text: key }), el('span', { class: 'record-value', text: value ?? '' }))))
  }

  function editForm () {
    if (found === null) return null
    const known = found.texts
    const form = /** @type {HTMLFormElement} */ (el('form', { class: 'edit', 'aria-label': `Edit the records of ${name}` },
      el('div', { class: 'fields' }, keysShown().map((key) => field(key, known[key] ?? ''))),
      el('div', { class: 'add-key' },
        el('label', { for: `${one.label}-new-key`, text: 'Another record key' }),
        el('div', { class: 'inline' },
          el('input', { id: `${one.label}-new-key`, name: 'new-key', type: 'text', placeholder: 'for example org.matrix', autocomplete: 'off', spellcheck: 'false' }),
          button('Add', { quiet: true, onClick: () => addField(form) }))),
      el('p', { class: 'hint', text: 'Saving sends one transaction. Records are public. An empty field removes the record.' }),
      el('div', { class: 'actions' },
        button('Save records', { primary: true, type: 'submit' }),
        button('Cancel', { quiet: true, onClick: () => { mode = 'view'; render() } }))))
    form.addEventListener('submit', (event) => { event.preventDefault(); void saveRecords(form) })
    return form
  }

  function endBlock () {
    const words = endSignInsWords(name)
    const cancel = button(words.cancel, { onClick: () => { mode = 'view'; render() } })
    queueMicrotask(() => cancel.focus())
    return el('div', { class: 'confirm', role: 'group', 'aria-labelledby': `${one.label}-end-title` },
      el('h4', { id: `${one.label}-end-title`, text: words.title }),
      words.body.map((line) => el('p', { text: line })),
      el('div', { class: 'actions' }, cancel, button(words.confirm, { danger: true, onClick: () => { void endSignIns() } })))
  }

  function endBlocked () {
    if (end === null || end.canEnd) return null
    const above = (/** @type {string | null} */ text) => text !== null && status.why !== null && status.why.includes(text)
    const remedy = end.retry || moveOffer(attributed).offered ? end.remedy : null
    return notice('info', 'You cannot end its sign-ins from here.',
      el('p', { text: above(end.words) ? 'The reason is the one given above.' : end.words }),
      remedy === null || above(remedy) ? null : el('p', { text: remedy }),
      end.retry ? button('Check again', { quiet: true, onClick: () => { end = null; void load() } }) : null)
  }

  /**
   * One line of the card: what it is, with its icon, and the value; `copy` adds the button that copies a long value.
   * @param {'wallet' | 'note' | 'link' | 'server' | 'key'} iconName
   * @param {string} label
   * @param {import('./dom.js').Child} value
   * @param {{ text: string, what: string } | null} [copy]
   */
  function row (iconName, label, value, copy = null) {
    return el('div', {},
      el('dt', {}, icon(iconName, { size: 16 }), el('span', { text: label })),
      el('dd', {}, value),
      copy === null ? null : el('div', { class: 'row-action' }, copyButton(copy.text, copy.what)))
  }

  function render () {
    const ended = found === null ? null : endedAt(found.texts[NOT_BEFORE_KEY])
    const hash = found === null ? null : contenthashView(found.contenthash)
    const editable = found !== null && found.resolver !== null && busy === ''
    const movable = moveOffer(attributed).offered
    const muted = (/** @type {string} */ text) => el('span', { class: 'muted', text })
    fill(host,
      el('article', { class: 'id-card', 'aria-labelledby': `${one.label}-name`, 'data-ok': String(status.ok) },
        el('header', {},
          el('span', { class: 'id-tile', 'aria-hidden': 'true' }, icon('card', { size: 18 })),
          el('h3', { id: `${one.label}-name`, class: 'id-name' },
            el('span', { class: 'id-label', text: one.label }), el('span', { class: 'id-suffix', text: name.slice(one.label.length) })),
          el('span', { class: `badge ${status.tone}` }, icon(status.ok ? 'shieldCheck' : 'alert', { size: 14 }), status.label)),
        status.why === null || mode === 'move' ? null : el('p', { class: 'muted why', text: status.why }),
        loadFailure !== '' ? notice('warn', loadFailure, button('Try again', { quiet: true, onClick: () => { loadFailure = ''; void load() } })) : null,
        found === null && loadFailure === '' ? working('Reading its records…') : null,
        found === null ? null : el('dl', { class: 'record-list' },
          row('wallet', 'Address', found.addr === null ? muted('Not set') : addressCode(found.addr), found.addr === null ? null : { text: found.addr, what: 'Copy the address' }),
          row('note', 'Text records', recordRows()),
          row('link', 'Contenthash', hash === null ? muted('Not set') : [el('span', { class: 'tag', text: hash.kind }), ' ', hexCode(hash.hex)]),
          row('server', 'Resolver', found.resolver === null ? muted('None') : addressCode(found.resolver),
            found.resolver === null ? null : { text: found.resolver, what: 'Copy the resolver address' }),
          row('key', 'Sign-ins', signInsWords(ended, app.now()))),
        busy === '' ? null : working(busy),
        mode === 'edit' ? editForm() : null,
        mode === 'end' ? endBlock() : null,
        mode === 'move' ? moveHost : null,
        mode === 'view' && found !== null
          ? el('div', { class: 'actions' },
            attributed.records.ok
              ? button('Edit records', { disabled: !editable, onClick: () => { mode = 'edit'; outcome = null; render() } })
              : movable ? button(moveWords(one.label).title, { primary: true, disabled: busy !== '', onClick: startMove }) : null,
            end?.canEnd === true ? button('End all sign-ins', { quiet: true, disabled: busy !== '', onClick: () => { mode = 'end'; outcome = null; render() } }) : null)
          : null,
        mode === 'view' ? endBlocked() : null,
        outcome))
  }

  render()
  return load
}
