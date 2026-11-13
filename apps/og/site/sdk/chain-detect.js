// Which Chain the page gets: Orivon's when `orivon.use` is there, the wallet extension's `window.ethereum`
// otherwise. Orivon also installs a `window.ethereum` shim, so `orivon.use` is looked for first.

import { ChainError } from './chain.js'
import { eip1193Chain } from './chain-eip1193.js'
import { orivonChain } from './chain-orivon.js'

/**
 * @param {{ orivon?: any, ethereum?: any }} [scope]
 * @returns {import('./chain.js').Chain}
 */
export function detectChain (scope = /** @type {{ orivon?: any, ethereum?: any }} */ (globalThis)) {
  if (typeof scope.orivon?.use === 'function') return orivonChain(scope.orivon)
  if (typeof scope.ethereum?.request === 'function') return eip1193Chain(scope.ethereum)
  throw new ChainError('noWallet', 'this browser has neither Orivon nor an Ethereum wallet')
}
