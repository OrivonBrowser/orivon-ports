// The page of the `.orv` name resolver. Orivon starts it hidden, hands it `window.orivonIntegration`, and calls the
// function provided here for each `.orv` name a person opens or a site asks about. It reads Ethereum through
// ETH_NET_0_1_READONLY only, with the `use` of the call it is serving.

import { orivonChain } from '../sdk/chain-orivon.js'
import { resolveOrv } from './orv-names.js'

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

window.orivonIntegration.provide('NAMES_0_1', {
  /** @param {{ use: import('../sdk/chain-orivon.js').OrivonUse, signal: AbortSignal }} context @param {string} name */
  resolve: (context, name) => untilAborted(resolveOrv(orivonChain({ use: context.use }), name, { signal: context.signal }), context.signal)
})
