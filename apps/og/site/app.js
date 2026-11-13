// What every view shares: the chain the page was given, who is connected, the one registration, and the resolver's own reads of a name.
// Views receive this object and never reach for a global, so a test or a screenshot can hand them another.

import { isAddress } from './sdk/abi.js'
import { ChainError } from './sdk/chain.js'
import { detectChain } from './sdk/chain-detect.js'
import { suggestFees } from './sdk/chain.js'
import { readCensus } from './resolver/og-census.js'
import { inspectOg } from './resolver/og-names.js'
import { createSession } from './resolver/og-tail.js'
import { checkOrivonId } from './badge-reads.js'
import { watchReads } from './header-model.js'
import { createManage, MANAGE_KEYS } from './manage-flow.js'
import { mergeNames } from './names-model.js'
import { checkAdded, readHints, readWrappedTokens } from './names-reads.js'
import { createRegistration } from './register-flow.js'
import { readFacts } from './register-reads.js'
import { extensionSender, orivonSender } from './register-send.js'
import { resolveTipAddress } from './register-tip.js'
import { createRelay } from './relay.js'
import { createStore } from './store.js'

/** @param {unknown} error */
function connectWords (error) {
  const reason = typeof error === 'object' && error !== null && 'reason' in error ? String(error.reason) : ''
  return reason === 'declined' ? 'You did not let this page see your address.' : 'The wallet did not share an address.'
}

/**
 * @param {any} [scope] `globalThis`, or a stand-in
 * @param {{ census?: () => Promise<import('./resolver/og-census.js').Census>, store?: ReturnType<typeof createStore>, ids?: import('./sdk/orivonid.js').namesOf }} [parts]
 *   tests give their own census, store, and the search for Orivon IDs
 */
export function createApp (scope = globalThis, parts = {}) {
  /** @type {import('./sdk/chain.js').Chain | null} */
  let chain = null
  /** @type {ChainError | null} */
  let missing = null
  /** @type {() => import('./header-model.js').Reading} */
  let readingNow = () => 'unknown'
  const sessionListeners = new Set()
  /** @type {{ address: string | null, failure: string | null, asking: boolean, reading: import('./header-model.js').Reading }} */
  const session = { address: null, failure: null, asking: false, reading: 'unknown' }
  try {
    chain = detectChain(scope)
    if (chain.kind === 'orivon') {
      const watched = watchReads(chain, (reading) => { session.reading = reading; notify(sessionListeners) })
      chain = watched.chain
      readingNow = watched.reading
    }
  } catch (error) {
    missing = error instanceof ChainError ? error : new ChainError('noWallet', 'no wallet')
  }
  session.reading = readingNow()
  const relay = createRelay({ app: scope.orivon?.app })
  const sender = chain === null ? null : chain.kind === 'orivon' ? orivonSender({ orivon: scope.orivon, chain, relay }) : extensionSender(chain)

  const ogSession = createSession()
  /** @type {Promise<import('./resolver/og-census.js').Census> | null} */
  let census = null
  const loadCensus = parts.census ?? (async () => {
    const response = await fetch(new URL('resolver/census.json', import.meta.url))
    if (!response.ok) throw new Error(`the census could not be read (${response.status})`)
    return readCensus(await response.json())
  })

  /** @type {Promise<string | null> | null} */
  let connecting = null
  /** Asks the wallet for the address, once at a time. Answers the address, or null with `session.failure` worded. */
  function connect () {
    if (chain === null) return Promise.resolve(null)
    const wallet = chain
    connecting ??= (async () => {
      session.asking = true
      session.failure = null
      notify(sessionListeners)
      try {
        const [first] = await wallet.addresses()
        if (first === undefined || !isAddress(first)) throw new ChainError('declined', 'the wallet shared no address')
        session.address = first
        return first
      } catch (error) {
        session.failure = connectWords(error)
        return null
      } finally {
        session.asking = false
        connecting = null
        notify(sessionListeners)
      }
    })()
    return connecting
  }

  /** @type {{ state: Record<string, any>, request: Record<string, any> | null }} */
  const registration = { state: { phase: 'idle' }, request: null }
  const registrationListeners = new Set()
  const clock = { sleep: (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const flow = chain === null || sender === null
    ? null
    : createRegistration({
      chain, sender, clock,
      onState: (state) => {
        registration.state = state
        if (state['request'] !== undefined) registration.request = state['request']
        notify(registrationListeners)
      }
    })

  /** @type {{ state: Record<string, any>, request: Record<string, any> | null }} */
  const managing = { state: { phase: 'idle' }, request: null }
  const manageListeners = new Set()
  const manageFlow = chain === null || sender === null
    ? null
    : createManage({
      chain, sender, clock,
      onState: (state) => {
        managing.state = state
        if (state['request'] !== undefined) managing.request = state['request']
        notify(manageListeners)
      }
    })
  /** One series at a time: the sender signs for the series it was prepared for. */
  const busy = () => [registration.state, managing.state].some((state) => ['checking', 'signing', 'running'].includes(String(state['phase'])))

  /** @type {ReturnType<typeof createStore>} */
  const store = parts.store ?? createStore((() => { try { return scope.localStorage ?? null } catch { return null } })())
  /**
   * A name a series sent a transaction for, kept on this device when the account holds it unwrapped: the chain lists no such names.
   * @param {string} account @param {string} label @param {Record<string, any>} state a series state in phase `done` or `stopped`
   */
  function rememberStarted (account, label, state) {
    const sent = Array.isArray(state['steps']) && state['steps'].some((/** @type {Record<string, any>} */ step) => step['hash'] !== null && step['hash'] !== undefined)
    if (sent) store.remember(account, label)
  }

  /** @type {Map<string, { check: import('./badge-model.js').IdCheck, cache: import('./sdk/orivonid.js').NamesCache | null }>} */
  const idChecks = new Map()

  return {
    scope, chain, missing, relay, sender, flow, session, registration, managing, store,
    kind: chain?.kind ?? null,
    connect,
    /** @param {() => void} listener @returns {() => void} */
    onSession (listener) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
    /** @param {() => void} listener @returns {() => void} */
    onRegistration (listener) { registrationListeners.add(listener); return () => { registrationListeners.delete(listener) } },
    /** @param {() => void} listener @returns {() => void} */
    onManage (listener) { manageListeners.add(listener); return () => { manageListeners.delete(listener) } },
    busy,
    /** The registration as the panel started it, so a stop can be continued with the same choices. @param {Record<string, any>} request */
    async register (request) {
      if (flow === null || busy()) return null
      registration.request = request
      const ended = await flow.start(/** @type {any} */ (request))
      rememberStarted(String(request['account']), String(request['label']), ended)
      return ended
    },
    /** A change to a name the person holds, as the panel started it; `managing.request` is the one a stop continues. @param {import('./manage-plan.js').ManageRequest} request */
    async manageName (request) {
      if (manageFlow === null || busy()) return null
      managing.request = request
      const ended = await manageFlow.start(request)
      const next = /** @type {import('./manage-plan.js').ManageRequest | undefined} */ (ended['request'])
      if (next !== undefined) managing.request = next
      rememberStarted(request.account, request.label, ended)
      return ended
    },
    resetRegistration () {
      registration.state = { phase: 'idle' }
      registration.request = null
      notify(registrationListeners)
    },
    resetManage () {
      managing.state = { phase: 'idle' }
      managing.request = null
      notify(manageListeners)
    },
    /**
     * The name as the resolver reads it, and the wrapper's state: one call of the resolver's `inspectOg` at the latest block (a name
     * someone reserved a minute ago is not free), and the registration's reads at that block.
     * @param {string} label
     * @param {AbortSignal} [signal]
     * @param {{ keys?: readonly string[], account?: string | null }} [options] `keys`: the text keys to read besides the answered ones; `account`: also read its primary name
     */
    async lookupName (label, signal, options = {}) {
      if (chain === null) throw new ChainError('noWallet', 'no chain')
      census ??= loadCensus()
      const loaded = await census.catch((error) => { census = null; throw error })
      const keys = options.keys ?? []
      const inspection = await inspectOg(chain, label, { session: ogSession, census: loaded, signal }, { latest: true, ...(keys.length === 0 ? {} : { keys }) })
      return { inspection, facts: await readFacts(chain, label, inspection.block, keys, options.account ?? null) }
    },
    /** The text keys the page of one name reads: every key the resolver records. */
    manageKeys: MANAGE_KEYS,
    /**
     * The account's wrapped names and the names this device and the contracts bring up, each once.
     * @param {string} account
     */
    async loadNames (account) {
      if (chain === null) throw new ChainError('noWallet', 'no chain')
      const [wrapped, hints] = await Promise.all([readWrappedTokens(chain, account), readHints(chain, account).catch(() => /** @type {string[]} */ ([]))])
      return { ...wrapped, listed: mergeNames({ tokens: wrapped.tokens, remembered: store.names(account), hints }) }
    },
    /** A name typed to add to the list: checked on chain, and kept on this device only if the account holds it. @param {string} label @param {string} account */
    async addName (label, account) {
      if (chain === null) throw new ChainError('noWallet', 'no chain')
      const found = await checkAdded(chain, label, account)
      if (found.kind === 'added' || found.kind === 'finish') store.remember(account, label)
      return found
    },
    /** @param {string} account @param {string} label */
    forgetName (account, label) { store.forget(account, label) },
    /**
     * Whether an address holds an Orivon ID, read now. The answer is kept for the page's life, so a page that shows it twice reads once.
     * @param {string} address
     * @param {{ extra?: readonly string[], again?: boolean }} [options] `extra`: usernames typed to check; `again`: read it anew
     * @returns {Promise<import('./badge-model.js').IdCheck>}
     */
    async idCheck (address, options = {}) {
      if (chain === null) return { phase: 'failed', words: 'No chain to read Orivon ID from.' }
      const kept = idChecks.get(address.toLowerCase())
      if (kept !== undefined && options.again !== true && (options.extra ?? []).length === 0) return kept.check
      const done = await checkOrivonId(chain, address, [...store.idNames(), ...(options.extra ?? [])], { cache: kept?.cache ?? null, ...(parts.ids === undefined ? {} : { find: parts.ids }) })
      if (done.check.phase === 'read') {
        idChecks.set(address.toLowerCase(), done)
        for (const one of done.check.names) if ((options.extra ?? []).includes(one.label)) store.rememberId(one.label)
      }
      return done.check
    },
    /** The fee per gas the node suggests now, or null when it cannot say. */
    async feePerGas () {
      if (chain === null) return null
      try {
        const fees = await suggestFees(chain)
        return fees === null ? await chain.gasPrice() : (fees.maxFeePerGas - fees.maxPriorityFeePerGas) / 2n + fees.maxPriorityFeePerGas
      } catch {
        return null
      }
    },
    /** What `orivonstack.eth` points to now, for the tip line. */
    async lookupTip () {
      return chain === null ? { ok: false, words: 'No chain to look it up on, so no tip will be sent.' } : await resolveTipAddress(chain)
    },
    /** @param {string} hash */
    go (hash) { scope.location.hash = hash }
  }
}

/** @param {Set<() => void>} listeners */
function notify (listeners) {
  for (const listener of [...listeners]) listener()
}

/** @typedef {ReturnType<typeof createApp>} App */
