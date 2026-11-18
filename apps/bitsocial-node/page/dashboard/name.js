// The name screens: for each board this node hosts, the text record that makes an ENS name (`your-name.eth`, which Bitsocial also writes
// `your-name.bso`) point at it, shown exactly with a copy button for each part; the check of whether the name points at the board now,
// asked of the node's own name resolvers (`handle.names`, `node/worker/name-api.js`); and, only on a page that has a wallet (`window.ethereum`),
// the transaction that sets the record, said in plain words before the wallet is asked and sent only when the person presses its button.
// The board's address is changed in the app's own settings, which the screen points to.

import { createBoardSection, failure } from './board-section.js'
import { h } from './dom.js'
import { ethereumWords } from './ethereum-words.js'
import { termOf } from './terms.js'

/** @typedef {{ request: (args: { method: string, params?: unknown[] }) => Promise<any> }} Wallet */

/** A name as ENS spells it: `.bso` is the `.eth` name of the same label. @param {string | null | undefined} name */
const ensOf = (name) => (name ?? '').replace(/\.bso$/, '.eth')

/** @param {unknown} value @returns {value is Wallet} */
const isWallet = (value) => typeof value === 'object' && value !== null && typeof /** @type {any} */ (value).request === 'function'

/**
 * What a check found, in a board owner's words.
 * @param {{ outcome: string, resolved: string | null, errors?: Array<{ message: string }> }} answer
 * @param {{ name: string, already: boolean, where: string, term: import('./terms.js').Term }} context
 */
function checkWords (answer, { name, already, where, term }) {
  const reason = answer.errors?.[0]?.message ?? ''
  switch (answer.outcome) {
    case 'here': return already
      ? `${name} points at this ${term.board}, and the ${term.board}'s address is already ${name}. Nothing more to do.`
      : `${name} points at this ${term.board}. The last step is the ${term.board}'s address: set it to ${name} in ${where}.`
    case 'elsewhere': return `${name} points at another ${term.board} (${String(answer.resolved)}). Set the record above on the name to point it at this ${term.board}.`
    case 'none': return `${name} has no bitsocial record yet. Set the record above, wait until the transaction is in a block, then check again.`
    case 'invalid': return `${name} has a bitsocial record that is not a ${term.board}'s key: ${reason}`
    case 'no-resolver': return 'This node reads no names (it runs without the internet).'
    default: return `The node could not read Ethereum, so it cannot say where ${name} points${reason === '' ? '' : ` (${reason})`}. Try again in a minute.`
  }
}

/** What the person is told a prepared transaction does, a line each. @param {{ name: string, ensName: string, value: string, transaction: { to: string } }} prepared @param {import('./terms.js').Term} term */
function summaryOf ({ name, ensName, value, transaction }, term) {
  return [
    'This sends one transaction on Ethereum mainnet, from the account you choose in your wallet.',
    `It calls ${transaction.to}, the resolver of ${ensName}, to set the text record "bitsocial" of ${ensName} to ${value}, so that ${name} points at this ${term.board}.`,
    `It sends no money, and the network fee is yours. Only an account that manages ${ensName} can do it: from any other account it fails and the fee is lost.`,
    'Your wallet shows the transaction and asks you to confirm. Nothing is sent until you do.'
  ]
}

/**
 * @param {{ doc: Document, handle: any, app: { name: string, term?: string, addressSetting?: string }, classes: Record<string, string>, state: Record<string, any>,
 *   copy: (text: string) => Promise<void>, wallet: () => unknown }} context
 */
function createName ({ doc, handle, app, classes, state, copy, wallet }) {
  const at = (/** @type {string} */ role) => classes[role] ?? ''
  const term = termOf(app)
  const where = app.addressSetting ?? `the app's own settings for this ${term.board}`

  /** @param {import('./board-section.js').Listed} first */
  function createCard (first) {
    let listed = first
    const { address } = first
    let typed = false
    let busy = false
    /** @type {boolean | null} */
    let walletShown = null
    /** @type {any} */
    let prepared = null

    const input = h(doc, 'input', { class: at('input'), type: 'text', autocomplete: 'off', placeholder: 'your-name.bso', 'data-nd-input': 'name', on: { input: () => { typed = true; invalidate() } } })
    const nameError = h(doc, 'span', { class: at('fieldError'), role: 'alert', 'data-nd-error': 'name' })
    const message = h(doc, 'p', { class: at('formMessage'), role: 'status', 'data-nd-message': '' })
    const badge = h(doc, 'span', { class: at('badge'), 'data-nd-state': '' })
    const show = h(doc, 'button', { class: at('button'), type: 'submit', 'data-nd-action': 'show', text: 'Show the record', on: { click: (/** @type {any} */ event) => { event.preventDefault?.(); run(showRecord).catch(() => {}) } } })
    const check = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'check', text: 'Check the name', on: { click: () => { run(checkName).catch(() => {}) } } })
    const checkLine = h(doc, 'p', { class: at('formMessage'), role: 'status', 'data-nd-check': '' })

    /** @type {Record<string, any>} */
    const facts = Object.fromEntries(['name', 'key', 'value'].map((part) => [part, h(doc, 'code', { 'data-nd-fact': part })]))
    const copying = (/** @type {string} */ part, /** @type {string} */ label) => h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': `copy-${part}`, text: label, on: { click: () => { copyPart(part).catch(() => {}) } } })
    const same = h(doc, 'p', { class: at('note'), 'data-nd-same': '' })
    const record = h(doc, 'div', { class: at('request'), hidden: true, 'data-nd-record': '' },
      h(doc, 'p', { class: at('label'), text: 'Set this text record on the name' }),
      h(doc, 'dl', { class: at('facts') },
        h(doc, 'dt', { text: 'Name' }), h(doc, 'dd', {}, facts['name'], ' ', copying('name', 'Copy')),
        h(doc, 'dt', { text: 'Record key' }), h(doc, 'dd', {}, facts['key'], ' ', copying('key', 'Copy')),
        h(doc, 'dt', { text: 'Value' }), h(doc, 'dd', {}, facts['value'], ' ', copying('value', 'Copy'))),
      same,
      h(doc, 'p', { class: at('note'), text: 'Any name manager can set it (in ENS\'s own app: open the name, Records, Edit Records, Add record). This page sends nothing by itself.' }))

    const prepare = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'prepare', text: 'Prepare the transaction', on: { click: () => { run(prepareTransaction).catch(() => {}) } } })
    const send = h(doc, 'button', { class: at('button'), type: 'button', 'data-nd-action': 'send', text: 'Ask my wallet to send it', on: { click: () => { run(sendTransaction).catch(() => {}) } } })
    const summary = h(doc, 'div', { class: at('request'), hidden: true, 'data-nd-summary': '' })
    const calldata = h(doc, 'pre', { class: at('preview'), hidden: true, 'data-nd-preview': 'calldata' })
    const sendRow = h(doc, 'div', { class: at('actions') })
    const txLine = h(doc, 'p', { class: at('formMessage'), role: 'status', 'data-nd-tx': '' })
    const walletNote = h(doc, 'p', { class: at('note'), 'data-nd-wallet-note': '' })
    const walletActions = h(doc, 'div', { class: at('actions') })
    const walletBox = h(doc, 'div', { 'data-nd-wallet': '' }, walletNote, walletActions, summary, calldata, sendRow, txLine)

    const form = h(doc, 'form', { class: at('form'), novalidate: true, 'data-nd-form': `name:${address}`, on: { submit: (/** @type {any} */ event) => { event.preventDefault(); run(showRecord).catch(() => {}) } } },
      h(doc, 'div', { class: at('field'), 'data-nd-field': 'name', 'data-nd-owner': address },
        h(doc, 'label', { class: at('label'), text: 'Name' }),
        h(doc, 'span', { class: at('control') }, input, h(doc, 'span', { class: at('hint'), text: 'An ENS name you own, ending .bso or .eth.' })),
        nameError),
      message, h(doc, 'div', { class: at('actions') }, show, check), checkLine)
    const root = h(doc, 'article', { class: at('board'), 'data-nd-name-board': address }, h(doc, 'header', { class: at('boardHead') }, h(doc, 'h3', { class: at('address'), text: address }), badge), form, record, walletBox)

    const typedName = () => input.value.trim()

    /** A prepared transaction is dropped: it is not shown, and the button that sends it goes. */
    function dropTransaction () {
      summary.hidden = true
      calldata.hidden = true
      txLine.textContent = ''
      prepared = null
      send.remove()
    }

    /** The answers made for the name in the field are taken back when the name changes: they were made for another name. */
    function invalidate () {
      nameError.textContent = ''
      message.textContent = ''
      checkLine.textContent = ''
      checkLine.setAttribute('data-nd-check', '')
      record.hidden = true
      dropTransaction()
    }

    /** @param {string} words @param {boolean} [bad] */
    function say (words, bad = false) { txLine.textContent = words; txLine.setAttribute('data-nd-failed', bad ? 'true' : 'false') }

    /** Runs one press of a button: nothing starts while another is running, and the buttons wait for it. @param {() => Promise<void>} work */
    async function run (work) {
      if (busy) return
      busy = true
      draw()
      try { await work() } finally { busy = false; draw() }
    }

    /** The name in the field, or nothing and a line that asks for it. */
    function needName () {
      if (typedName() !== '') return typedName()
      nameError.textContent = 'Type the name first, for example your-name.bso.'
      return null
    }

    async function showRecord () {
      const name = needName()
      if (name === null) return
      invalidate()
      try {
        const answer = await handle.names('record', { address, name })
        facts['name'].textContent = answer.ensName
        facts['key'].textContent = answer.key
        facts['value'].textContent = answer.value
        same.textContent = answer.ensName === answer.name ? '' : `${answer.name} is the same name as ${answer.ensName}: Bitsocial writes an ENS .eth name with a .bso ending, and both are read the same way. The record is set on ${answer.ensName}.`
        record.hidden = false
      } catch (error) { nameError.textContent = failure(error).words }
    }

    /** @param {string} part */
    async function copyPart (part) {
      try { await copy(facts[part].textContent); message.textContent = 'Copied.' } catch { message.textContent = 'Copying did not work: select the text and copy it yourself.' }
    }

    async function checkName () {
      const name = needName()
      if (name === null) return
      message.textContent = ''
      checkLine.textContent = ''
      checkLine.setAttribute('data-nd-check', '')
      try {
        const answer = await handle.names('check', { address, name })
        checkLine.textContent = checkWords(answer, { name, already: ensOf(listed.name) === answer.ensName, where, term })
        checkLine.setAttribute('data-nd-check', answer.outcome)
      } catch (error) { checkLine.textContent = failure(error).words; checkLine.setAttribute('data-nd-check', 'failed') }
    }

    async function prepareTransaction () {
      const name = needName()
      if (name === null) return
      invalidate()
      try {
        prepared = await handle.names('transaction', { address, name })
        summary.textContent = ''
        summary.append(...summaryOf(prepared, term).map((line) => h(doc, 'p', { class: at('note'), text: line })))
        calldata.textContent = prepared.transaction.data
        summary.hidden = false
        calldata.hidden = false
        sendRow.append(send)
      } catch (error) { say(failure(error).words, true) }
    }

    async function sendTransaction () {
      const provider = wallet()
      if (prepared === null || !isWallet(provider)) return
      const { transaction } = prepared
      try {
        const accounts = await provider.request({ method: 'eth_requestAccounts' })
        const account = Array.isArray(accounts) ? accounts[0] : undefined
        if (typeof account !== 'string') { say('The wallet gave no account.', true); return }
        const chain = await provider.request({ method: 'eth_chainId' })
        if (chain !== '0x1') { say(`Your wallet is on another network (chain ${String(chain)}). Switch it to Ethereum mainnet and press the button again.`, true); return }
        const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: transaction.to, data: transaction.data, value: transaction.value }] })
        say(`Sent: ${String(hash)}. It takes a minute to be in a block; then press "Check the name".`)
      } catch (error) {
        if (/** @type {any} */ (error)?.code === 4001) say('You declined it in your wallet. Nothing was sent.')
        else say(`The wallet did not send it: ${String(/** @type {any} */ (error)?.message ?? error).slice(0, 200)}`, true)
      }
    }

    /** What the wallet part of the card says and offers: the button only where there is a wallet to ask, one line about it where there is none. */
    function drawWallet () {
      const has = isWallet(wallet())
      if (has === walletShown) return
      walletShown = has
      walletNote.textContent = has
        ? 'Your wallet can set the record for you. Prepare the transaction to read what it does first: nothing is sent until you confirm it in your wallet.'
        : 'No wallet is available in this browser, so this page cannot set the record for you: set it in any name manager with the three values above (a wallet in the browser would let this page prepare the transaction).'
      if (has) walletActions.append(prepare)
      else { prepare.remove(); dropTransaction() }
    }

    /** @param {import('./board-section.js').Listed} next */
    function draw (next = listed) {
      listed = next
      badge.textContent = listed.name === null || listed.name === undefined ? 'No name yet' : `Named ${listed.name}`
      badge.setAttribute('data-nd-state', listed.name === null || listed.name === undefined ? 'unnamed' : 'named')
      if (!typed) input.value = listed.name ?? ''
      drawWallet()
      for (const button of [show, check, prepare, send]) button.disabled = busy
    }

    draw()
    return { element: root, draw }
  }

  /** The one line that says which path reads Ethereum for this node; it has no text, and is not drawn, for a node that does not say. */
  const reading = h(doc, 'p', { class: at('note'), hidden: true })
  /** @param {{ path?: string, why?: string } | null | undefined} reads */
  function drawReading (reads) {
    const words = ethereumWords(reads)
    state['ethereum'] = words === null ? null : reads
    reading.hidden = words === null
    reading.textContent = words ?? ''
    if (words === null) reading.removeAttribute('data-nd-ethereum')
    else reading.setAttribute('data-nd-ethereum', String(reads?.path))
  }

  return createBoardSection({
    doc, classes, state, name: 'name', term, notes: [reading],
    title: `Give a ${term.board} a name`,
    intro: `A ${term.board}'s address is its public key until its owner gives it a name. A name is an ENS name you own, such as your-name.eth (Bitsocial also writes it your-name.bso), with one text record that points at the ${term.board}. Type the name, set the record it needs, check that it points at the ${term.board}, and then set the ${term.board}'s address to the name in the app's own settings. Nothing is sent from this page unless you send a transaction from your wallet.`,
    emptyText: `This node hosts no ${term.boards} yet. Create one and it appears here.`,
    list: async () => { const answer = await handle.names('boards'); drawReading(answer?.ethereum); return answer },
    makeCard: createCard
  })
}

/** The section: offered when the app names `name` and the handle can make a name call. */
export const name = {
  name: 'name',
  feature: 'name',
  /** @param {Parameters<typeof createName>[0]} context */
  mount: (context) => (typeof context.handle?.names === 'function' ? createName(context) : null)
}
