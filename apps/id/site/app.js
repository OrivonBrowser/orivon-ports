// What every view shares: the chain the page was given, who is connected, the one registration, and the store. Views
// receive this object and never reach for a global, so a test or a screenshot can hand them another.

import { isAddress } from './sdk/abi.js'
import { ChainError } from './sdk/chain.js'
import { detectChain } from './sdk/chain-detect.js'
import { createRegistration, storeKey, webStore } from './register-flow.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import { trackHashes, trackPlan, trackTiming } from './register-model.js'
import { orivonBroadcaster, walletBroadcaster } from './register-send.js'
import { createRelay } from './relay.js'
import { watchReads } from './header-model.js'

/** Set after a first connection, so a later visit asks for the address again without waiting to be told. */
export const CONNECTED_KEY = 'orivonid.connected'

/** @returns {Storage} the page's `localStorage`, or one that keeps nothing when the browser refuses it */
function pickStorage (/** @type {any} */ scope) {
  try {
    if (scope.localStorage !== undefined && scope.localStorage !== null) return scope.localStorage
  } catch {
    // Blocked storage is the same as none.
  }
  const map = new Map()
  return /** @type {Storage} */ ({
    length: 0, clear: () => map.clear(), key: () => null,
    getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)) }, removeItem: (key) => { map.delete(key) }
  })
}

/** The account a stored registration belongs to, without asking the wallet. @param {Storage} storage @returns {string | null} */
export function storedAccount (storage) {
  const prefix = storeKey('')
  try {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      const account = key !== null && key.startsWith(prefix) ? key.slice(prefix.length) : ''
      if (isAddress(account)) return account
    }
  } catch {
    return null
  }
  return null
}

/**
 * @param {any} [scope] `globalThis`, or a stand-in
 */
export function createApp (scope = globalThis) {
  /** @type {import('./sdk/chain.js').Chain | null} */
  let chain = null
  /** @type {ChainError | null} */
  let missing = null
  /** What Orivon did with the page's read of Ethereum, as far as a read has told: see header-model.js. @type {() => import('./header-model.js').Reading} */
  let readingNow = () => 'unknown'
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
  const storage = pickStorage(scope)
  const store = webStore(storage)
  const relay = createRelay({ app: scope.orivon?.app })
  const clock = { now: () => Date.now(), sleep: (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

  /** @type {{ address: string | null, failure: string | null, asking: boolean, reading: import('./header-model.js').Reading }} */
  const session = { address: null, failure: null, asking: false, reading: readingNow() }
  const sessionListeners = new Set()
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
        store.set(CONNECTED_KEY, '1')
        return first
      } catch (error) {
        const found = reasonOfError(error)
        session.failure = found.reason === 'declined' ? 'You did not let Orivon ID see your address.' : REASONS[found.reason]?.words ?? found.detail
        return null
      } finally {
        session.asking = false
        connecting = null
        notify(sessionListeners)
      }
    })()
    return connecting
  }

  /** @type {{ state: Record<string, any>, plan: readonly string[] | null, timing: import('./register-model.js').Timing | null, hashes: Record<string, string>, name: string, receivedAt: number }} */
  const registration = { state: { phase: 'idle' }, plan: null, timing: null, hashes: {}, name: '', receivedAt: Date.now() }
  const registrationListeners = new Set()

  /** @param {Record<string, any>} state */
  function onState (state) {
    const now = Date.now()
    registration.timing = trackTiming(registration.timing, state, now)
    if (typeof state['name'] === 'string') registration.name = state['name']
    registration.hashes = state['phase'] === 'ready' || (state['phase'] === 'checking' && state['what'] === 'name') ? {} : trackHashes(registration.hashes, state)
    registration.plan = trackPlan(registration.plan, state)
    registration.state = state
    registration.receivedAt = now
    notify(registrationListeners)
  }

  const broadcaster = chain === null ? null : chain.kind === 'orivon' ? orivonBroadcaster({ orivon: scope.orivon, chain, relay }) : walletBroadcaster(chain)
  const flow = chain === null || broadcaster === null ? null : createRegistration({ chain, broadcaster, store, clock, onState })

  return {
    scope, chain, missing, store, storage, relay, flow, broadcaster, session, registration, clock,
    kind: chain?.kind ?? null,
    connect,
    /** @param {() => void} listener @returns {() => void} */
    onSession (listener) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
    /** @param {() => void} listener @returns {() => void} */
    onRegistration (listener) { registrationListeners.add(listener); return () => { registrationListeners.delete(listener) } },
    /** Forgets the state on screen, not the stored registration. */
    resetRegistration () {
      registration.state = { phase: 'idle' }
      registration.plan = null
      registration.timing = null
      registration.hashes = {}
      registration.name = ''
      notify(registrationListeners)
    },
    /** Starts reading a registration the store holds, if one does. */
    resumeStored () {
      const account = storedAccount(storage)
      return flow === null || account === null ? Promise.resolve(null) : flow.resume(account)
    },
    now: () => Math.floor(Date.now() / 1000),
    /** @param {string} hash */
    go (hash) { scope.location.hash = hash },
    /** @param {string} url Leaves the page, for the site that asked to be signed in to. */
    leave (url) { scope.location.assign(url) }
  }
}

/** @param {Set<() => void>} listeners */
function notify (listeners) {
  for (const listener of [...listeners]) listener()
}

/** @typedef {ReturnType<typeof createApp>} App */
