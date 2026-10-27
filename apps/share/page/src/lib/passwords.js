// Passwords for a share: one made here, and an estimate of a typed one. The estimate is a plain count (length,
// character classes, repeats, sequences, a short list of the passwords everyone tries), not a guarantee; the list
// and the thresholds are the whole of it.

import { MIN_PASSWORD_LENGTH } from './limits.js'

/** Crockford's base32: digits and letters without i, l, o and u. Five bits per character. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
const GROUPS = 5
const GROUP_LENGTH = 5

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'qwerty', 'qwerty123', 'qwertyuiop',
  'azerty', 'letmein', 'welcome', 'welcome1', 'admin', 'administrator', 'login', 'master', 'hello', 'hello123', 'iloveyou',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman', 'trustno1', 'shadow', 'abc123',
  'abcdef', 'abcdefgh', 'abcd1234', '123456', '1234567', '12345678', '123456789', '1234567890', '0123456789', '111111',
  '000000', '123123', '654321', 'secret', 'changeme', 'default', 'guest', 'test', 'test123', 'testing', 'asdfgh', 'asdfghjkl',
  'zxcvbn', 'zxcvbnm', 'bitcoin', 'ethereum', 'satoshi', 'crypto', 'orivon', 'ipfs', 'whatever', 'freedom', 'liverpool',
  'chocolate', 'internet', 'computer', 'michael', 'jennifer', 'jordan', 'summer', 'winter', 'flower', 'purple', 'starwars'
])
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz']

/** A password of 125 random bits: five groups of five characters, joined by dashes. */
export function generatePassword () {
  const random = new Uint8Array(GROUPS * GROUP_LENGTH)
  globalThis.crypto.getRandomValues(random)
  const groups = []
  for (let g = 0; g < GROUPS; g++) {
    let group = ''
    for (let i = 0; i < GROUP_LENGTH; i++) group += ALPHABET[/** @type {number} */ (random[g * GROUP_LENGTH + i]) & 31]
    groups.push(group)
  }
  return groups.join('-')
}

/** The size of the set of characters a password draws on. @param {string} password */
function poolOf (password) {
  let pool = 0
  if (/[a-z]/.test(password)) pool += 26
  if (/[A-Z]/.test(password)) pool += 26
  if (/\d/.test(password)) pool += 10
  if (/[ -/:-@[-`{-~]/.test(password)) pool += 33
  if (/[^\u0000-\u007f]/.test(password)) pool += 100
  return Math.max(pool, 10)
}

/** How many of the characters carry information: a repeat or a step along a keyboard row or the alphabet carries almost none. @param {string} password */
function effectiveLength (password) {
  const lower = password.toLowerCase()
  const chars = [...lower]
  let weight = 0
  for (let i = 0; i < chars.length; i++) {
    const here = chars[i] ?? ''
    const code = here.codePointAt(0) ?? 0
    const before = chars[i - 1]
    const beforeCode = before === undefined ? -1 : before.codePointAt(0) ?? -1
    const twoBefore = chars[i - 2]
    const repeated = before === here
    const stepped = beforeCode >= 0 && Math.abs(code - beforeCode) === 1 && twoBefore !== undefined && (twoBefore.codePointAt(0) ?? -9) - beforeCode === beforeCode - code
    const onRow = i >= 2 && ROWS.some((row) => row.includes(lower.slice(i - 2, i + 1)) || row.split('').reverse().join('').includes(lower.slice(i - 2, i + 1)))
    weight += repeated || stepped || onRow ? 0.2 : 1
  }
  return weight
}

/** The estimate: characters that carry information times the bits a character of the pool carries, less for the guessable ways people write. @param {string} password */
export function estimateBits (password) {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((pattern) => pattern.test(password)).length
  return effectiveLength(password) * Math.log2(poolOf(password)) * 0.7 * (classes === 1 ? 0.75 : 1)
}

/**
 * @param {string} password
 * @returns {{ label: 'weak' | 'fair' | 'strong' | 'very strong', acceptable: boolean, hint: string }}
 */
export function passwordStrength (password) {
  if (password !== password.trim()) {
    return { label: 'weak', acceptable: false, hint: 'A password cannot start or end with a space.' }
  }
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return { label: 'weak', acceptable: false, hint: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }
  }
  const bare = password.toLowerCase().replace(/[\d\W_]+$/u, '')
  if (COMMON.has(password.toLowerCase()) || COMMON.has(bare)) {
    return { label: 'weak', acceptable: false, hint: 'This is one of the first passwords anyone tries.' }
  }
  const bits = estimateBits(password)
  if (bits < 40) return { label: 'weak', acceptable: false, hint: 'Add more characters, or use the one made for you.' }
  if (bits < 55) return { label: 'fair', acceptable: true, hint: 'Longer is stronger. The one made for you is the safest.' }
  if (bits < 75) return { label: 'strong', acceptable: true, hint: '' }
  return { label: 'very strong', acceptable: true, hint: '' }
}
