// The optional private send, the one Web2 part of this site. It posts each signed transaction to Flashbots Protect
// with the page's own `fetch`, which Orivon serves only for a host the person granted under `https.connect`
// (the manifest declares it; the page asks when the person turns the switch on). Nothing here runs otherwise.

import { toHex, utf8 } from './sdk/bytes.js'
import { keccak256 } from './sdk/keccak.js'

export const RELAY = Object.freeze({
  host: 'rpc.flashbots.net',
  url: 'https://rpc.flashbots.net',
  pattern: 'rpc.flashbots.net:443',
  capability: 'https.connect'
})

/** Names this short are the ones a sniper hunts; the page advises the switch for them. */
export const PRIVATE_ADVISED_UP_TO = 4

/** @param {string} label */
export const advisePrivate = (label) => utf8(label).length <= PRIVATE_ADVISED_UP_TO

/** The words beside the switch. `kind` is plain text beside the browser's mark of the relay, so the switch reads the same where the mark draws nothing. */
export const RELAY_WORDS = Object.freeze({
  kind: 'Web2',
  switchLabel: 'Send privately',
  explanation: 'A server (Flashbots Protect) sees each transaction and your IP address before it is public. ' +
    'That keeps a sniper who watches pending transactions from taking the name first. You can still send publicly.',
  publicWarning: 'A public send lets anyone watching the network see the name before it is registered and take it first.',
  advice: 'Advised for names of 3 and 4 letters.',
  asking: 'Checking with Orivon whether this page may connect to rpc.flashbots.net.',
  notAllowed: 'Orivon has not let this page connect to rpc.flashbots.net, and it does not ask again by itself. The switch stays off ' +
    'and the transactions go out publicly. To allow it, press the key in the address bar and switch on "Connect to rpc.flashbots.net" ' +
    '(or press "Review permissions" if the popup offers it), then turn this switch on again.',
  failed: 'The private relay did not take the transaction. Send it publicly instead, or try again.',
  sendPublicly: 'Send publicly',
  tryAgain: 'Try the relay again'
})

/** @typedef {'notGranted' | 'unavailable' | 'rejected' | 'badAnswer' | 'timeout'} RelayReason */

export class RelayError extends Error {
  /**
   * @param {RelayReason} reason
   * @param {string} message
   * @param {{ maybeSent?: boolean, cause?: unknown, hash?: string }} [extra] `maybeSent`: the relay may have received it, so the hash can still be mined
   */
  constructor (reason, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'RelayError'
    this.reason = reason
    this.maybeSent = extra.maybeSent === true
    /** The hash of the signed transaction, which the sender adds once it knows what it posted. @type {string | undefined} */
    this.hash = extra.hash
  }
}

/** @typedef {{ capability: string, patterns: readonly string[] }} GrantLike */
/** @typedef {{ grants: () => Promise<readonly GrantLike[]>, requestGrant: (request: { capability: string, patterns: string[] }) => Promise<boolean> }} AppLike */

/**
 * @param {object} [parts] what the page has; tests give their own
 * @param {typeof globalThis.fetch} [parts.fetch]
 * @param {AppLike | undefined} [parts.app] `orivon.app`; absent outside Orivon, where there is no grant to hold
 * @param {number} [parts.timeoutMs]
 */
export function createRelay (parts = {}) {
  const { timeoutMs = 20_000 } = parts
  const app = 'app' in parts ? parts.app : /** @type {{ orivon?: { app?: AppLike } }} */ (globalThis).orivon?.app
  const post = parts.fetch ?? globalThis.fetch?.bind(globalThis)

  async function granted () {
    if (app === undefined) return true
    try {
      return (await app.grants()).some((grant) => grant.capability === RELAY.capability && grant.patterns.includes(RELAY.pattern))
    } catch {
      return false
    }
  }

  /** Asks the person to allow the host. Call it from the click that turns the switch on. @returns {Promise<boolean>} */
  async function allow () {
    if (await granted()) return true
    if (app === undefined) return true
    try {
      return (await app.requestGrant({ capability: RELAY.capability, patterns: [RELAY.pattern] })) === true
    } catch {
      return false
    }
  }

  /**
   * `eth_sendRawTransaction` of signed bytes, answering their hash. A failure is a RelayError and the caller decides
   * what to do next; this never sends anywhere else.
   * @param {Uint8Array} raw
   * @returns {Promise<string>}
   */
  async function send (raw) {
    if (!(await granted())) throw new RelayError('notGranted', 'the page is not allowed to connect to the relay')
    if (post === undefined) throw new RelayError('unavailable', 'this page cannot make requests')
    const expected = '0x' + toHex(keccak256(raw))
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x' + toHex(raw)] })
    /** @type {Response} */
    let response
    try {
      response = await post(RELAY.url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw new RelayError(timedOut ? 'timeout' : 'unavailable', timedOut ? 'the relay did not answer in time' : 'the relay could not be reached', { maybeSent: true, cause: error })
    }
    if (!response.ok) throw new RelayError('unavailable', `the relay answered HTTP ${response.status}`)
    /** @type {{ result?: unknown, error?: { message?: unknown } }} */
    let answer
    try {
      answer = await response.json()
    } catch (error) {
      throw new RelayError('badAnswer', 'the relay answered something that is not JSON', { maybeSent: true, cause: error })
    }
    if (answer.error !== undefined) {
      const message = typeof answer.error?.message === 'string' ? answer.error.message : 'the relay refused the transaction'
      if (/already known|known transaction/i.test(message)) return expected
      throw new RelayError('rejected', message)
    }
    if (typeof answer.result !== 'string' || answer.result.toLowerCase() !== expected) {
      throw new RelayError('badAnswer', 'the relay answered another transaction hash', { maybeSent: true })
    }
    return expected
  }

  return { granted, allow, send }
}
