// Hiding a short name among others. Inside Orivon the person's Ethereum node is a light client whose execution
// server sees every slot and call it is asked for, so asking about the name a person searches for hands that server
// the name. A name of 3 or 4 characters has few enough spellings to be read back from its id, so a question about
// one is asked among questions about 7 other names of the same length, in a random order, and only the answer
// about the real one is kept. A longer name needs none: its spellings are too many to try.

import { utf8 } from './sdk/bytes.js'
import { isReserved, isValidLabel } from './sdk/orivonid.js'

/** Names up to this many bytes are asked about among decoys. */
export const DECOYED_UP_TO = 4

/** How many other names go with the real one. */
export const DECOY_COUNT = 7

/** What the page shows beside the search. */
export const SEARCH_WORDS = 'The server behind your Ethereum node can see which names you check; for a name of 3 or 4 letters ' +
  'this page asks about 7 other names with it, to hide yours among them.'

/** @typedef {(bytes: number) => Uint8Array} Random */

/** @type {Random} */
const cryptoRandom = (bytes) => globalThis.crypto.getRandomValues(new Uint8Array(bytes))

/** A whole number from 0 up to but not including `n`, evenly. @param {Random} random @param {number} n */
function below (random, n) {
  const limit = 2 ** 32 - (2 ** 32 % n)
  let word = 0
  for (let tries = 0; tries < 64; tries++) {
    const bytes = random(4)
    word = (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0
    if (word < limit) break
  }
  return word % n
}

/** @template T @param {Random} random @param {T[]} list @returns {T[]} a shuffled copy */
export function shuffled (random, list) {
  const out = [...list]
  for (let at = out.length - 1; at > 0; at--) {
    const other = below(random, at + 1)
    const held = /** @type {T} */ (out[at])
    out[at] = /** @type {T} */ (out[other])
    out[other] = held
  }
  return out
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'

/** The characters a decoy may have where the real name has `char`: a letter stays a letter, a digit a digit, a hyphen a hyphen. @param {string} char */
const alphabetOf = (char) => char === '-' ? '-' : DIGITS.includes(char) ? DIGITS : LETTERS

/** @param {string[]} alphabets @param {number} index the name at this place in the space those alphabets span */
function nameAt (alphabets, index) {
  let rest = index
  let name = ''
  for (let at = alphabets.length - 1; at >= 0; at--) {
    const alphabet = /** @type {string} */ (alphabets[at])
    name = alphabet.charAt(rest % alphabet.length) + name
    rest = Math.floor(rest / alphabet.length)
  }
  return name
}

/**
 * The other names to ask about with `label`: valid, of its length and shape, not reserved (a real search never asks
 * about a reserved name, so one would give itself away), all different. None for a name past DECOYED_UP_TO.
 * @param {string} label
 * @param {Random} [random]
 * @param {number} [count]
 * @returns {string[]}
 */
export function decoysFor (label, random = cryptoRandom, count = DECOY_COUNT) {
  if (utf8(label).length > DECOYED_UP_TO) return []
  const alphabets = [...label].map(alphabetOf)
  const space = alphabets.reduce((size, alphabet) => size * alphabet.length, 1)
  /** @type {Set<string>} */
  const chosen = new Set()
  const take = (/** @type {string} */ name) => {
    if (chosen.size < count && name !== label && !chosen.has(name) && isValidLabel(name) && !isReserved(name)) chosen.add(name)
  }
  for (let tries = 0; chosen.size < count && tries < 32 * count; tries++) take(nameAt(alphabets, below(random, space)))
  for (let at = below(random, space), swept = 0; chosen.size < count && swept < space; at = (at + 1) % space, swept++) take(nameAt(alphabets, at))
  return [...chosen]
}

/**
 * Asks about a name among decoys. A repeated search for the same name keeps the same decoys for as long as the
 * page lives, because two fresh sets would share one name: the real one.
 * @param {Random} [random]
 */
export function createHider (random = cryptoRandom) {
  /** @type {Map<string, string[]>} */
  const sets = new Map()

  /** @param {string} label */
  function decoys (label) {
    let set = sets.get(label)
    if (set === undefined) {
      set = decoysFor(label, random)
      sets.set(label, set)
    }
    return set
  }

  return {
    decoys,

    /**
     * `ask(name)` for the real name and for each decoy, started together in a random order. What the decoys answer, or
     * fail with, is dropped; the real name's answer or failure is the result. Nothing else is asked until all have ended.
     * @template T
     * @param {string} label
     * @param {(name: string) => Promise<T>} ask
     * @returns {Promise<T>}
     */
    async among (label, ask) {
      const others = decoys(label)
      if (others.length === 0) return await ask(label)
      /** @type {Promise<T> | null} */
      let real = null
      const started = shuffled(random, [label, ...others]).map((name) => {
        const one = ask(name)
        if (name === label) real = one
        return one.then(() => undefined, () => undefined)
      })
      await Promise.all(started)
      return await /** @type {Promise<T>} */ (real)
    }
  }
}
