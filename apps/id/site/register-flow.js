// The registration as a resumable state machine. `decide` is pure: given the pending record and what the chain
// shows now, it names the state to draw and the one thing to do next. `createRegistration` runs that in a loop
// with the chain, a clock, a store and a broadcaster handed to it. The secret and each hash are stored before
// the send they belong to, and on resume the truth is read from the chain, never from the store alone.

import { isAddress, sameAddress } from './sdk/abi.js'
import { toHex } from './sdk/bytes.js'
import { ChainError } from './sdk/chain.js'
import { isReserved, isValidLabel, nameOf, ownerOf, price } from './sdk/orivonid.js'
import { createHider } from './register-decoys.js'
import { checkRegistration, observe, predictedResolver } from './register-reads.js'
import { REASONS, reasonOfError } from './register-reasons.js'
import {
  approveTx, commitTx, deployResolverTx, makeCommitment, MAX_COMMITMENT_AGE, MIN_COMMITMENT_AGE, recordsTx, REGISTER_GAS_LIMIT, registerTx, withMargin
} from './register-tx.js'
import { advisePrivate, RelayError } from './relay.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {'commit' | 'approve' | 'deploy' | 'register' | 'records'} Step */
/** @typedef {'checking' | 'ready' | 'committing' | 'maturing' | 'revealing' | 'recording' | 'verifying' | 'done' | 'failed'} Phase */
/** @typedef {{ step: Step, hash: string | null, at: number }} Pending a send that may not be mined yet; `at` is clock time in ms */

/**
 * The pending registration, as stored. One per account.
 * @typedef {object} Rec
 * @property {1} v
 * @property {string} label
 * @property {string} owner
 * @property {string} resolver
 * @property {'deploy' | 'reuse'} resolverMode
 * @property {string} secret 0x and 32 bytes
 * @property {string} commitment
 * @property {string} price decimal wei of DAI
 * @property {boolean} private whether the reveal goes to the private relay
 * @property {Record<string, string>} texts
 * @property {Pending | null} pending
 * @property {Partial<Record<Step, string>>} hashes
 */

/**
 * @typedef {object} Broadcaster Signs a transaction (asking the person), then sends it.
 * @property {(tx: { from: string, to: string, data: Uint8Array, gas: number }) => Promise<Prepared>} prepare
 */
/** @typedef {{ hash: string | null, send: (options: { private: boolean }) => Promise<string> }} Prepared `hash` is known before sending when the signed bytes are */
/** @typedef {{ get: (key: string) => unknown, set: (key: string, value: string) => unknown, delete: (key: string) => unknown }} Store */
/** @typedef {{ now: () => number, sleep: (ms: number) => Promise<void> }} Clock */

export const POLL_MS = 4000
export const PENDING_TIMEOUT_MS = 180_000
export const VERIFY_TRIES = 4
const MAX_TURNS = 600

/**
 * A check that failed because the node or the wallet did not answer is made once more, after this pause, before the
 * page says so: it only reads, so asking again sends nothing.
 */
export const CHECK_RETRY_MS = 1000
const CHECK_RETRY_REASONS = ['unavailable', 'timeout']

/** @type {Map<string, Promise<unknown>>} */
const queues = new Map()

/** Runs `work` after every earlier send of the same account has finished, so two never share a nonce. @template T @param {string} account @param {() => Promise<T>} work @returns {Promise<T>} */
export function serialPerAccount (account, work) {
  const key = account.toLowerCase()
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
  queues.set(key, run)
  return run.finally(() => { if (queues.get(key) === run) queues.delete(key) })
}

/** @param {Storage} storage a `localStorage`; a read or write that throws is treated as nothing stored @returns {Store} */
export function webStore (storage) {
  return {
    get: (key) => { try { return storage.getItem(key) } catch { return null } },
    set: (key, value) => { try { storage.setItem(key, value) } catch { /* the store is a convenience; the chain stays the truth */ } },
    delete: (key) => { try { storage.removeItem(key) } catch { /* as above */ } }
  }
}

/** @param {string} account */
export const storeKey = (account) => `orivonid.registration.v1.${account.toLowerCase()}`

/**
 * A stored record, read back. Whatever the label fixes is derived again and must agree with what was stored: the
 * label must be one the registrar sells, the price its price, and the commitment the registrar's hash of the record's
 * own label, owner, resolver and secret. `shape` is a record that is not one at all.
 * @param {unknown} text
 * @returns {{ ok: true, rec: Rec } | { ok: false, mismatch: 'shape' | 'label' | 'price' | 'commitment' }}
 */
export function readRec (text) {
  try {
    const rec = JSON.parse(String(text))
    const hex32 = (/** @type {unknown} */ value) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
    if (rec?.v !== 1 || typeof rec.label !== 'string' || !isAddress(rec.owner) || !isAddress(rec.resolver) || !hex32(rec.secret) || !hex32(rec.commitment)) return { ok: false, mismatch: 'shape' }
    if (typeof rec.price !== 'string' || !/^\d+$/.test(rec.price) || (rec.resolverMode !== 'deploy' && rec.resolverMode !== 'reuse')) return { ok: false, mismatch: 'shape' }
    if (!isValidLabel(rec.label) || isReserved(rec.label)) return { ok: false, mismatch: 'label' }
    if (rec.price !== String(price(rec.label))) return { ok: false, mismatch: 'price' }
    if (makeCommitment(rec.label, rec.owner, rec.resolver, rec.secret).toLowerCase() !== rec.commitment.toLowerCase()) return { ok: false, mismatch: 'commitment' }
    return { ok: true, rec: { ...rec, private: rec.private === true, texts: rec.texts ?? {}, pending: rec.pending ?? null, hashes: rec.hashes ?? {} } }
  } catch {
    return { ok: false, mismatch: 'shape' }
  }
}

/** @param {unknown} text @returns {Rec | null} */
export function parseRec (text) {
  const read = readRec(text)
  return read.ok ? read.rec : null
}

/** @param {Rec} rec @param {Phase} phase @param {Record<string, unknown>} [extra] */
const view = (rec, phase, extra = {}) => ({
  phase, label: rec.label, name: nameOf(rec.label), owner: rec.owner, resolver: rec.resolver, price: price(rec.label),
  private: rec.private, hashes: { ...rec.hashes }, ...extra
})

/** @param {Rec} rec @param {string} reason @param {string} detail @param {Record<string, unknown>} [extra] */
function failure (rec, reason, detail, extra = {}) {
  const known = REASONS[reason] ?? REASONS['reverted']
  return { view: view(rec, 'failed', { reason, detail, words: known?.words, recover: known?.recover, ...extra }), act: { kind: 'fail', reason } }
}

/**
 * The transactions a registration still has to make, from what the chain shows alone: the approval when the allowance
 * falls short of the price, the resolver when no code is at its address. The record's own word for either is not asked.
 * Null once the name is held, when the chain no longer says what was needed; a step that left a hash stays listed by it.
 * @param {Rec} rec
 * @param {any} facts
 * @returns {Step[] | null}
 */
function planOf (rec, facts) {
  if (facts.holder !== null || typeof facts.allowance !== 'bigint') return null
  return ['commit', ...(facts.allowance < price(rec.label) ? /** @type {const} */ (['approve']) : []), ...(facts.resolverCode ? [] : /** @type {const} */ (['deploy'])), 'register', 'records']
}

/**
 * The state to draw and the next act, from the pending record and the facts of the chain. No I/O. A state made before
 * the name is held carries `transactions`, the plan the chain implies, so a page that was reloaded draws all of them.
 * @param {Rec} rec
 * @param {any} facts what `observe` read, plus `pending`: { step, hash, status: 'waiting' | 'timedOut' | 'reverted' } or null
 * @param {number} [pollMs]
 * @returns {{ view: Record<string, unknown>, act: { kind: string, [key: string]: unknown } }}
 */
export function decide (rec, facts, pollMs = POLL_MS) {
  const out = decideStep(rec, facts, pollMs)
  const plan = planOf(rec, facts)
  return plan === null ? out : { ...out, view: { ...out.view, transactions: plan } }
}

/** @param {Rec} rec @param {any} facts @param {number} pollMs */
function decideStep (rec, facts, pollMs) {
  const cost = price(rec.label)
  const hold = facts.pending
  const at = Number(facts.commitmentAt ?? 0)
  const now = facts.head.timestamp
  const timing = at === 0 ? {} : { matureAt: at + MIN_COMMITMENT_AGE, expiresAt: at + MAX_COMMITMENT_AGE, secondsToMaturity: Math.max(0, at + MIN_COMMITMENT_AGE - now), blockTimestamp: now }
  const registered = facts.holder !== null
  /** @param {Step} step @param {Phase} phase @param {{ to: string, data: Uint8Array }} call */
  const send = (step, phase, call) => ({ view: view(rec, phase, { ...timing, step, sending: 'estimating' }), act: { kind: 'send', step, call, phase } })
  const phaseOf = (/** @type {Step} */ step) => {
    if (step === 'commit') return 'committing'
    if (step === 'records' || (registered && step === 'deploy')) return 'recording'
    return step === 'register' || now >= at + MIN_COMMITMENT_AGE ? 'revealing' : 'maturing'
  }

  if (hold?.status === 'reverted') return failure(rec, 'reverted', `${hold.step} was mined and reverted`, { step: hold.step, hash: hold.hash, pendingStatus: 'reverted' })
  if (hold?.status === 'timedOut') {
    return failure(rec, 'notMined', `${hold.step} was not mined in time`, { step: hold.step, hash: hold.hash, pendingStatus: 'timedOut', offerPublic: rec.private && hold.step === 'register' })
  }
  if (registered) {
    if (!sameAddress(facts.holder, rec.owner)) return failure(rec, 'taken', facts.holder, { holder: facts.holder })
    if (facts.attributed?.ok === true) return { view: view(rec, 'done', { attribution: facts.attributed }), act: { kind: 'done' } }
    if (hold !== null) return { view: view(rec, phaseOf(hold.step), { step: hold.step, hash: hold.hash, sending: 'mining' }), act: { kind: 'wait', ms: pollMs } }
    if (!facts.resolverCode) return send('deploy', 'recording', deployResolverTx(rec.owner))
    if (!facts.recordsDone) return send('records', 'recording', recordsTx(rec.resolver, rec.label, rec.owner, rec.texts))
    return { view: view(rec, 'verifying', { attribution: facts.attributed }), act: { kind: 'verify', ms: pollMs } }
  }
  if (hold !== null) return { view: view(rec, phaseOf(hold.step), { ...timing, step: hold.step, hash: hold.hash, sending: 'mining' }), act: { kind: 'wait', ms: pollMs } }
  if (at === 0) return send('commit', 'committing', commitTx(rec.commitment))
  if (now >= at + MAX_COMMITMENT_AGE) return { view: view(rec, 'checking', { what: 'expired', ...timing }), act: { kind: 'restart' } }
  const mature = now >= at + MIN_COMMITMENT_AGE
  if (facts.allowance < cost) return send('approve', mature ? 'revealing' : 'maturing', approveTx(cost))
  if (!mature) {
    if (rec.resolverMode === 'deploy' && !facts.resolverCode) return send('deploy', 'maturing', deployResolverTx(rec.owner))
    const ms = Math.min(pollMs, Math.max(1000, timing.secondsToMaturity * 1000))
    return { view: view(rec, 'maturing', timing), act: { kind: 'wait', ms } }
  }
  return send('register', 'revealing', registerTx(rec.label, rec.owner, rec.resolver, rec.secret))
}

/**
 * @param {object} deps
 * @param {Chain} deps.chain
 * @param {Broadcaster} deps.broadcaster
 * @param {Store} deps.store
 * @param {Clock} deps.clock
 * @param {(bytes: number) => Uint8Array} [deps.random]
 * @param {(state: Record<string, unknown>) => void} [deps.onState]
 * @param {number} [deps.pollMs]
 * @param {number} [deps.pendingTimeoutMs]
 * @param {number} [deps.verifyTries]
 */
export function createRegistration (deps) {
  const { chain, broadcaster, store, clock, onState = () => {}, pollMs = POLL_MS, pendingTimeoutMs = PENDING_TIMEOUT_MS, verifyTries = VERIFY_TRIES } = deps
  const random = deps.random ?? ((/** @type {number} */ bytes) => globalThis.crypto.getRandomValues(new Uint8Array(bytes)))
  const hider = createHider(random)
  /** @type {Record<string, unknown>} */
  let current = { phase: 'checking' }
  /** @type {Rec | null} */
  let rec = null
  /** @type {any} */
  let ready = null
  /** @type {{ step: Step, prepared: Prepared, gas: number } | null} */
  let held = null
  let floor = 0
  let stopped = false
  /** @type {Promise<Record<string, unknown>> | null} */
  let running = null
  /** @type {Promise<void>} */
  let turns = Promise.resolve()
  let started = false

  /** @param {Record<string, unknown>} state */
  function emit (state) {
    current = state
    onState(state)
    return state
  }
  const save = async () => { if (rec !== null) await store.set(storeKey(rec.owner), JSON.stringify(rec)) }
  const forgetStored = async () => { if (rec !== null) await store.delete(storeKey(rec.owner)) }
  /** @param {string} reason @param {string} detail @param {Record<string, unknown>} [extra] */
  const failed = (reason, detail, extra = {}) => emit({ phase: 'failed', reason, detail, words: REASONS[reason]?.words, recover: REASONS[reason]?.recover, ...extra })

  /** One check at a time: each asks the node up to 8 questions at once, and the node takes only 16 in flight. */
  let checking = Promise.resolve()
  /** @param {unknown} input @param {string} [account] */
  function check (input, account) {
    const run = checking.then(() => checkNow(input, account))
    checking = run.then(() => undefined, () => undefined)
    return run
  }

  /** @param {unknown} input @param {string} [account] */
  async function checkNow (input, account) {
    for (let attempt = 1; ; attempt++) {
      try {
        const owner = account ?? (await chain.addresses())[0]
        if (owner === undefined || !isAddress(owner)) return failed('noWallet', 'no address')
        emit({ phase: 'checking', what: 'name' })
        const found = await checkRegistration(chain, input, owner, hider)
        if (!found.ok) return failed(found.reason, found.detail, { during: 'checking', ...found.extra })
        ready = { ...found, owner }
        started = false
        const needs = { approve: found.allowance < found.price, deployResolver: found.resolver.mode === 'deploy' }
        return emit({
          phase: 'ready', label: found.label, name: nameOf(found.label), owner, price: found.price, balance: found.balance, allowance: found.allowance,
          resolver: found.resolver.address, resolverMode: found.resolver.mode, receiver: found.receiver, advisePrivate: advisePrivate(found.label), needs,
          transactions: ['commit', ...(needs.approve ? ['approve'] : []), ...(needs.deployResolver ? ['deploy'] : []), 'register', 'records']
        })
      } catch (error) {
        const found = reasonOfError(error)
        if (attempt === 1 && CHECK_RETRY_REASONS.includes(found.reason)) {
          await clock.sleep(CHECK_RETRY_MS)
          continue
        }
        return failed(found.reason, found.detail, { during: 'checking' })
      }
    }
  }

  /** @returns {Promise<Record<string, unknown> | null>} */
  async function pendingFact () {
    const sent = rec?.pending ?? null
    if (sent === null) return null
    if (sent.hash === null) return { step: sent.step, hash: null, status: 'lost' }
    const receipt = await chain.getTransactionReceipt(sent.hash)
    if (receipt === null) return { step: sent.step, hash: sent.hash, status: clock.now() - sent.at > pendingTimeoutMs ? 'timedOut' : 'waiting' }
    return { step: sent.step, hash: sent.hash, status: receipt.status === 1 ? 'mined' : 'reverted', blockNumber: receipt.blockNumber }
  }

  /**
   * Asks the person to sign, stores the hash, sends, and waits for the receipt: one send of one account. A step is
   * estimated before it is signed, except a reveal that goes to the private relay: an estimate would hand the node the
   * label and the secret first, so that one gets a fixed limit and is not simulated.
   * @param {Step} step
   * @param {{ to: string, data: Uint8Array }} call
   * @param {string} phase
   */
  async function sendStep (step, call, phase) {
    const own = /** @type {Rec} */ (rec)
    await serialPerAccount(own.owner, async () => {
      const tx = { from: own.owner, to: call.to, data: call.data }
      let prepared = held?.step === step ? held.prepared : null
      if (prepared === null) {
        const gas = step === 'register' && own.private ? REGISTER_GAS_LIMIT : withMargin(await chain.estimateGas(tx))
        emit(view(own, /** @type {Phase} */ (phase), { step, sending: 'signing' }))
        prepared = await broadcaster.prepare({ ...tx, gas })
        held = prepared.hash === null ? null : { step, prepared, gas }
      }
      own.pending = { step, hash: prepared.hash, at: clock.now() }
      if (prepared.hash !== null) own.hashes[step] = prepared.hash
      await save()
      emit(view(own, /** @type {Phase} */ (phase), { step, sending: 'broadcasting', hash: prepared.hash }))
      let hash
      try {
        hash = await prepared.send({ private: step === 'register' && own.private })
      } catch (error) {
        if (error instanceof RelayError && !error.maybeSent) { own.pending = null; await save() }
        throw error
      }
      own.pending = { step, hash, at: own.pending.at }
      own.hashes[step] = hash
      await save()
      emit(view(own, /** @type {Phase} */ (phase), { step, sending: 'mining', hash }))
      const receipt = await chain.waitForReceipt(hash, { timeoutMs: pendingTimeoutMs, intervalMs: pollMs, sleep: clock.sleep, now: clock.now })
      floor = Math.max(floor, receipt.blockNumber)
      own.pending = null
      held = null
      await save()
      if (receipt.status !== 1) throw new ChainError('reverted', `${step} was mined and reverted`, { hash })
      if (step === 'records') emit(view(own, 'verifying', { hash }))
    })
  }

  /** The loop: read the chain, decide, do one thing, until a state that waits for the person or ends. @returns {Promise<Record<string, unknown>>} */
  async function drive () {
    stopped = false
    let verifying = 0
    let early = 0
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (stopped || rec === null) return current
      const own = rec
      let next
      try {
        const facts = await observe(chain, own, floor)
        if (facts.stale) { await clock.sleep(1000); continue }
        const pending = await pendingFact()
        if (pending?.status === 'mined' || pending?.status === 'lost') {
          floor = Math.max(floor, Number(pending['blockNumber'] ?? 0))
          own.pending = null
          held = null
          await save()
          continue
        }
        next = decide(own, { ...facts, pending }, pollMs)
      } catch (error) {
        const found = reasonOfError(error)
        return failed(found.reason, found.detail, { during: 'reading' })
      }
      emit(next.view)
      const act = /** @type {any} */ (next.act)
      if (act.kind === 'done') { await forgetStored(); rec = null; return current }
      if (act.kind === 'restart') {
        const label = own.label
        await forgetStored()
        rec = null
        const again = await check(label, own.owner)
        return again['phase'] === 'ready' ? emit({ ...again, expired: true }) : again
      }
      if (act.kind === 'fail') {
        if (act.reason === 'taken') { await forgetStored(); rec = null }
        return current
      }
      if (act.kind === 'verify' && ++verifying > verifyTries) return failed('notAttributed', 'the records are set but the name does not resolve to the address', { during: 'verifying' })
      if (act.kind === 'wait' || act.kind === 'verify') { await clock.sleep(act.ms); continue }
      try {
        await sendStep(act.step, act.call, act.phase)
      } catch (error) {
        const found = reasonOfError(error)
        const hash = error instanceof ChainError ? error.hash : undefined
        if ((found.reason === 'commitmentTooNew' || found.reason === 'commitmentTooOld') && act.step === 'register' && ++early <= 5) { await clock.sleep(pollMs); continue }
        if (found.reason === 'reverted' && act.step === 'register' && await ownerOf(chain, own.label).catch(() => null) !== null) { continue }
        const timedOut = error instanceof ChainError && error.reason === 'timeout' && hash !== undefined
        return failed(timedOut ? 'notMined' : found.reason, found.detail, {
          during: act.phase, step: act.step, hash: hash ?? own.pending?.hash ?? null, offerPublic: own.private && act.step === 'register'
        })
      }
    }
    return failed('unavailable', 'the registration made no progress', { during: 'running' })
  }

  const run = () => (running ??= drive().finally(() => { running = null }))

  /** One of start, resume and retry at a time: a second call waits for the first and then sees what it left. @template T @param {() => Promise<T>} work @returns {Promise<T>} */
  function exclusive (work) {
    const next = turns.then(work, work)
    turns = next.then(() => undefined, () => undefined)
    return next
  }

  return {
    state: () => current,
    stop: () => { stopped = true },
    check,

    /** Begins from a `ready` state: stores the secret first, then commits. @param {{ private?: boolean, texts?: Record<string, string> }} [options] */
    start: (options = {}) => exclusive(async () => {
      if (ready === null) {
        if (started) return current
        throw new Error('check the name first')
      }
      const stored = await store.get(storeKey(ready.owner))
      const other = stored === null || stored === undefined ? null : parseRec(stored)
      if (other !== null) return failed('pendingExists', other.label, { label: other.label })
      const secret = '0x' + toHex(random(32))
      const texts = options.texts ?? {}
      rec = {
        v: 1, label: ready.label, owner: ready.owner, resolver: ready.resolver.address, resolverMode: ready.resolver.mode === 'reuse' ? 'reuse' : 'deploy', secret,
        commitment: makeCommitment(ready.label, ready.owner, ready.resolver.address, secret), price: String(ready.price), private: options.private === true,
        texts, pending: null, hashes: {}
      }
      ready = null
      started = true
      held = null
      await save()
      return await run()
    }),

    /** Picks up what the store holds for the account, reading the truth from the chain; null when it holds nothing. @param {string} [account] */
    resume: (account) => exclusive(async () => {
      const owner = account ?? (await chain.addresses())[0]
      const stored = owner === undefined ? null : await store.get(storeKey(owner))
      const read = owner === undefined || stored === null || stored === undefined ? null : readRec(stored)
      if (read === null || (!read.ok && read.mismatch === 'shape')) return null
      /** @param {string} mismatch */
      const discard = async (mismatch) => {
        await store.delete(storeKey(/** @type {string} */ (owner)))
        rec = null
        held = null
        return failed('recordDiscarded', `the stored ${mismatch} does not match what it is derived from`, { mismatch })
      }
      if (!read.ok) return await discard(read.mismatch)
      const found = read.rec
      if (!sameAddress(found.owner, owner)) return await discard('owner')
      try {
        if (!sameAddress(found.resolver, await predictedResolver(chain, found.owner))) return await discard('resolver')
      } catch (error) {
        const why = reasonOfError(error)
        return failed(why.reason, why.detail, { during: 'reading' })
      }
      rec = found
      held = null
      emit({ phase: 'checking', what: 'chain', label: found.label })
      return await run()
    }),

    /** Tries the failed step again; `private: false` sends the reveal publicly instead. @param {{ private?: boolean }} [options] */
    retry: (options = {}) => exclusive(async () => {
      if (rec === null) return current
      if (options.private !== undefined) rec.private = options.private
      const sent = rec.pending
      if (sent !== null) {
        if (held?.step === sent.step) {
          try {
            await held.prepared.send({ private: sent.step === 'register' && rec.private })
          } catch (error) {
            const found = reasonOfError(error)
            return failed(found.reason, found.detail, { step: sent.step, hash: sent.hash, offerPublic: rec.private && sent.step === 'register' })
          }
          sent.at = clock.now()
        } else if (current['pendingStatus'] === 'timedOut' && options.private === undefined) {
          sent.at = clock.now()
        } else {
          rec.pending = null
          held = null
        }
      }
      await save()
      return await run()
    }),

    /** Drops the stored registration (before the reveal, nothing is lost but the commit's gas). */
    async forget () {
      stopped = true
      await forgetStored()
      rec = null
      held = null
      return emit({ phase: 'checking' })
    }
  }
}
