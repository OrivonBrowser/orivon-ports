// The two senders a registration can be given. Each takes a step's transaction and answers its hash once it is on its way.
//
// The Orivon one asks the wallet for the whole series at once when the wallet can sign a series (`ETH_0_1.signTransactions`, one
// confirmation), and otherwise signs each transaction when its turn comes (`signTransaction`, one confirmation each). Either way the
// signed bytes go out one at a time, through the person's node (`sendRawTransaction`) or, when the person chose it, the private relay,
// so the flow decides after each receipt whether the next one is sent at all. A wallet extension signs and sends in one request.

import { toHex } from './sdk/bytes.js'
import { ChainError, quantityHex, suggestFees } from './sdk/chain.js'
import { fromOrivonError, nonceAfter, noteBroadcast } from './sdk/chain-orivon.js'
import { keccak256 } from './sdk/keccak.js'
import { RelayError } from './relay.js'

/** @typedef {import('./sdk/chain.js').Chain} Chain */
/** @typedef {{ to: string, data: Uint8Array, value?: bigint, gas: number }} Tx */
/**
 * @typedef {object} Sender
 * @property {'orivon' | 'extension'} kind
 * @property {boolean} canSendPrivately
 * @property {(account: string, txs: readonly Tx[]) => Promise<{ signed: boolean }>} prepare asks for the whole series when the wallet signs one; `signed: false` when it signs one by one
 * @property {(index: number, account: string, tx: Tx, options: { private: boolean }) => Promise<string>} send signs what is not signed yet and sends it
 */

/** A gas estimate becomes a limit by this many percent, when it is above the limit the plan gave. */
const MARGIN_PERCENT = 125

/** @param {Record<string, any> | null | undefined} handle @param {string} fn @param {unknown[]} args */
async function invoke (handle, fn, args) {
  if (typeof handle?.[fn] !== 'function') throw new ChainError('declined', `${fn} was not allowed`)
  try {
    return await handle[fn](...args)
  } catch (error) {
    throw fromOrivonError(error, fn)
  }
}

/** The fields a transaction is written with for the wallet: nothing undefined, a value only when there is one. @param {Tx} tx */
function wireOf (tx) {
  return {
    to: tx.to,
    ...(tx.data.length === 0 ? {} : { data: tx.data.slice() }),
    ...(tx.value === undefined || tx.value === 0n ? {} : { value: quantityHex(tx.value) }),
    gas: tx.gas
  }
}

/**
 * @param {object} parts
 * @param {{ use: (codes: string[], options?: { groups?: string[] }) => Promise<readonly (Record<string, any> | null)[]> }} parts.orivon the page's `orivon`
 * @param {Chain} parts.chain for the nonce, the fees and the estimate
 * @param {{ send: (raw: Uint8Array) => Promise<string> }} parts.relay
 * @returns {Sender}
 */
export function orivonSender ({ orivon, chain, relay }) {
  /** @type {Promise<readonly (Record<string, any> | null)[]> | null} */
  let granted = null
  /** The signed series, by position. @type {{ raw: Uint8Array, hash: string }[]} */
  let series = []

  async function handles () {
    // `plan` is a group only the browser itself holds: Orivon leaves it out for a page, and a wallet that signs a series for a page lists the call.
    granted ??= orivon.use(['ETH_0_1', 'ETH_NET_0_1'], { groups: ['addresses', 'sign', 'plan', 'broadcast'] }).catch((error) => { granted = null; throw fromOrivonError(error) })
    const [eth, net] = await granted
    if (eth === null || eth === undefined || net === null || net === undefined) throw new ChainError('declined', 'the person did not allow it')
    return { eth, net }
  }

  /** @param {Record<string, any>} net @param {Uint8Array} raw @param {string} hash @param {() => void} note */
  async function broadcast (net, raw, hash, note) {
    try {
      const answered = await invoke(net, 'sendRawTransaction', [raw])
      note()
      if (String(answered).toLowerCase() !== hash) throw new ChainError('badAnswer', 'the node answered another transaction hash', { hash })
    } catch (error) {
      if (error instanceof ChainError && error.reason === 'timeout') {
        note()
        throw new ChainError('unknownOutcome', 'the broadcast took too long to know whether it went out', { cause: error, hash })
      }
      throw error
    }
    return hash
  }

  return {
    kind: 'orivon',
    canSendPrivately: true,
    async prepare (account, txs) {
      series = []
      const { eth } = await handles()
      if (typeof eth['signTransactions'] !== 'function') return { signed: false }
      const chainId = await invoke(eth, 'chainId', [])
      const signed = await invoke(eth, 'signTransactions', [txs.map((tx) => ({ ...wireOf(tx), chainId }))])
      if (!Array.isArray(signed) || signed.length !== txs.length || signed.some((raw) => !(raw instanceof Uint8Array))) {
        throw new ChainError('badAnswer', 'the wallet did not sign the whole series')
      }
      series = signed.map((raw) => ({ raw, hash: `0x${toHex(keccak256(raw))}` }))
      return { signed: true }
    },
    async send (index, account, tx, { private: priv }) {
      const { eth, net } = await handles()
      const known = series[index]
      /** @type {Uint8Array} */
      let raw
      /** @type {string} */
      let hash
      /** @type {number | null} */
      let nonce = null
      if (known !== undefined) {
        ({ raw, hash } = known)
      } else {
        const chainId = await invoke(eth, 'chainId', [])
        const estimate = await chain.estimateGas({ from: account, to: tx.to, data: tx.data, ...(tx.value === undefined ? {} : { value: tx.value }) }, 'latest')
        nonce = nonceAfter(orivon, account, await chain.getTransactionCount(account, 'latest'))
        const fees = await suggestFees(chain)
        const price = fees === null
          ? { gasPrice: quantityHex(await chain.gasPrice()) }
          : { maxFeePerGas: quantityHex(fees.maxFeePerGas), maxPriorityFeePerGas: quantityHex(fees.maxPriorityFeePerGas) }
        const gas = Math.max(tx.gas, Math.ceil((estimate * MARGIN_PERCENT) / 100))
        raw = /** @type {Uint8Array} */ (await invoke(eth, 'signTransaction', [{ from: account, ...wireOf({ ...tx, gas }), nonce, chainId, ...price }]))
        hash = `0x${toHex(keccak256(raw))}`
      }
      const noted = nonce
      const note = () => { if (noted !== null) noteBroadcast(orivon, account, noted) }
      if (!priv) return await broadcast(net, raw, hash, note)
      try {
        const sent = await relay.send(raw)
        note()
        return sent
      } catch (error) {
        if (error instanceof RelayError && error.maybeSent) { note(); error.hash = hash }
        throw error
      }
    }
  }
}

/**
 * @param {Chain} chain
 * @returns {Sender}
 */
export function extensionSender (chain) {
  return {
    kind: 'extension',
    canSendPrivately: false,
    async prepare () { return { signed: false } },
    async send (_index, account, tx, { private: priv }) {
      if (priv) throw new ChainError('invalid', 'this wallet signs and sends in one step, so it cannot send privately')
      return await chain.sendTransaction({ from: account, to: tx.to, data: tx.data, gas: tx.gas, ...(tx.value === undefined ? {} : { value: tx.value }) })
    }
  }
}
