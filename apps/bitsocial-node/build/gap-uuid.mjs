// Workaround, deletable when the shim's `crypto.randomFillSync` accepts any typed array: uuid's random-number pool is a
// Uint8Array, and crypto-browserify's version accepts only a Buffer where Node's accepts either.

import { replaceText } from './text-patch.mjs'

/** @type {import('./text-patch.mjs').Patch} */
export const uuidRandomValues = {
  name: 'uuid random values: crypto.randomFillSync(Uint8Array) throws in the shim',
  file: /uuid\/dist\/esm\/rng\.js$/,
  apply: replaceText('randomFillSync(rnds8Pool);', 'globalThis.crypto.getRandomValues(rnds8Pool);')
}
