// The page of the `.og` name resolver. Orivon starts it hidden, hands it `window.orivonIntegration`, and calls the functions provided
// here for each `.og` name a person opens or a site asks about. It reads Ethereum through ETH_NET_0_1_READONLY with the `use` of the
// call it is serving, and through ETH_0_1 and ETH_NET_0_1 only to set a record, which the person confirms in their wallet.
//
// What the page keeps between calls is one `Session` (the log windows it has read, the page's turns at the node, and the names it has
// written), one call queue (so everything the page asks together stays under what the browser allows one page) and the bundle's
// census. When the page starts it reads ahead, within a minute, what almost every answer needs, so the first name to open is not
// the one that pays for it.

import { callQueue, orivonChain } from '../sdk/chain-orivon.js'
import { ChainError } from '../sdk/chain.js'
import { readCensus } from './og-census.js'
import { parseOgName } from './og-name.js'
import { resolveOg, warmUp } from './og-names.js'
import { setOgRecord } from './og-set-record.js'
import { createSession, OgRefusal } from './og-tail.js'

/** What the page's read-ahead may take: it stops starting reads after this, and what it has read stays kept. */
const WARM_UP_MS = 50_000

/** Everything the page's calls share. */
const session = createSession()
const queue = callQueue()
const census = (async () => {
  const response = await fetch(new URL('census.json', import.meta.url))
  if (!response.ok) throw new Error(`the census could not be read (${response.status})`)
  return readCensus(await response.json())
})()
// A census that does not load fails each call that needs it; the page itself has nothing to say about it.
census.catch(() => {})

/**
 * Answers when the call is no longer wanted: the result of `work` is dropped and the wait ends.
 * @template T
 * @param {Promise<T>} work
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function untilAborted (work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const stop = () => { reject(signal.reason) }
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', stop) })
  })
}

/**
 * What the standard calls a failure: a node that cannot be asked, or that took too long, is `unavailable` or `timeout`; a refusal made in
 * words keeps its code and says its words on the loading screen and in the page's console first; anything else is `unavailable`.
 * @param {unknown} error
 * @param {{ progress?: (detail: string, fraction?: number) => void }} context
 * @returns {Error & { code: string }}
 */
function failure (error, context) {
  if (error instanceof OgRefusal) {
    context.progress?.(error.message)
    console.error(`[og-names] ${error.message}`)
    return error
  }
  const code = typeof error === 'object' && error !== null && 'code' in error && error.code === 'invalid' ? 'invalid' : error instanceof ChainError && error.reason === 'timeout' ? 'timeout' : 'unavailable'
  const message = error instanceof Error ? error.message : 'the call failed'
  console.error(`[og-names] ${message}`)
  return Object.assign(error instanceof Error ? error : new Error(message), { code })
}

/** @typedef {{ use: import('../sdk/chain-orivon.js').OrivonUse, signal: AbortSignal, deadlineAt: number, progress: (detail: string, fraction?: number) => void }} CallContext */

/** @param {CallContext} context */
const chainOf = (context) => orivonChain({ use: context.use }, { queue })

/** @param {CallContext} context @param {string} name */
async function resolve (context, name) {
  try {
    // A name outside .og is refused as invalid before the census is awaited, so that refusal never depends on a file that failed to load.
    parseOgName(name)
    const lookup = { session, census: await census, signal: context.signal, deadlineAt: context.deadlineAt, progress: context.progress }
    return await untilAborted(resolveOg(chainOf(context), name, lookup), context.signal)
  } catch (error) {
    throw failure(error, context)
  }
}

/** @param {CallContext} context @param {string} name @param {string} recordType @param {string} value */
async function setRecord (context, name, recordType, value) {
  try {
    return await untilAborted(setOgRecord(chainOf(context), session, { name, recordType, value }, { deadlineAt: context.deadlineAt, progress: context.progress }), context.signal)
  } catch (error) {
    throw failure(error, context)
  }
}

// The declaration lists both codes, so the browser holds this page to the vectors of each at install and accepts both here.
const integration = window.orivonIntegration
integration.provide('NAMES_0_1', { resolve })
integration.provide('NAMES_0_2', { resolve, setRecord })

census.then(async (loaded) => {
  await warmUp(orivonChain({ use: integration.use }, { queue }), { session, census: loaded, deadlineAt: session.now() + WARM_UP_MS }, (line) => { console.error(`[og-names] ${line}`) })
}).catch((error) => { console.error(`[og-names] read-ahead stopped: ${error instanceof Error ? error.message : String(error)}`) })
