// Passwords carried from one view to the next in memory only: a link's `key=` once read, or a remembered
// password handed over by My shares. Nothing here is written anywhere.

/** @type {Map<string, string>} */
const keys = new Map()

/** @param {string} cid @param {string} password */
export function rememberKey (cid, password) {
  keys.set(cid, password)
}

/** @param {string} cid @returns {string | null} */
export function keyFor (cid) {
  return keys.get(cid) ?? null
}
