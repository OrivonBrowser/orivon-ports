// What a challenge's excludes say and how a form edits them. An exclude is one rule that lets some publications past a challenge; a challenge
// has a list of them and one match is enough, while everything one rule names must hold. The fields are pkc-js 0.0.132's: `roles`, `publicKeys`
// and `names` (the `role` and `address` of earlier versions are refused when settings are written, so a rule that still holds them is read as the
// new ones), the scores, counts and ages, the publication types, a rate limit, the challenges passed and the reputation in other communities.
// A rule is edited as `Texts`: what each input holds, so a half-typed number is an error beside its field and never a wrong rule.

import { splitDuration, toSeconds } from './format.js'

export const ROLES = /** @type {const} */ (['owner', 'admin', 'moderator'])

/** The publication types, in the order a sentence names them. */
export const TYPES = /** @type {const} */ (['post', 'reply', 'vote', 'commentEdit', 'commentModeration', 'communityEdit'])

/** The fields this page edits; any other field of a rule is kept as it is. */
const KNOWN = ['roles', 'publicKeys', 'names', 'postScore', 'replyScore', 'postCount', 'replyCount', 'firstCommentTimestamp', 'publicationType', 'rateLimit', 'rateLimitChallengeSuccess', 'challenges', 'community']
const LEGACY = ['role', 'address']

/**
 * What a rule's inputs hold. `roles`, `types` and `after` are the ticked boxes (`after` by the key of the challenge, which follows a challenge when
 * the order changes); the rest is text, and empty means the condition is not used.
 * @typedef {{
 *   roles: string[], publicKeys: string, names: string, postScore: string, replyScore: string, postCount: string, replyCount: string,
 *   ageValue: string, ageUnit: string, types: string[], rateLimit: string, rateCounts: 'passed' | 'failed', after: string[],
 *   communityAddresses: string, communityMax: string, communityPostScore: string, communityReplyScore: string, communityAgeValue: string, communityAgeUnit: string
 * }} Texts
 */

/** @returns {Texts} */
export const emptyTexts = () => ({
  roles: [], publicKeys: '', names: '', postScore: '', replyScore: '', postCount: '', replyCount: '', ageValue: '', ageUnit: 'days', types: [],
  rateLimit: '', rateCounts: 'passed', after: [], communityAddresses: '', communityMax: '', communityPostScore: '', communityReplyScore: '', communityAgeValue: '', communityAgeUnit: 'days'
})

const isDomain = (/** @type {string} */ text) => text.includes('.')
const words = (/** @type {string} */ text) => text.split(/[\s,]+/).filter((one) => one !== '')
const list = (/** @type {unknown} */ value) => (Array.isArray(value) ? value.filter((one) => typeof one === 'string') : typeof value === 'string' ? [value] : [])

/** @param {Record<string, any>} exclude @returns {boolean} whether the rule is written with the fields of before 0.0.132 */
export const legacyOf = (exclude) => LEGACY.some((key) => key in exclude)

/** The rule with `role` as `roles` and `address` split into `publicKeys` and `names`. @param {Record<string, any>} exclude */
function current (exclude) {
  if (!legacyOf(exclude)) return exclude
  const { role, address, ...rest } = exclude
  const addresses = list(address)
  return {
    ...rest,
    ...(list(role).length + list(rest['roles']).length > 0 ? { roles: [...list(rest['roles']), ...list(role)] } : {}),
    ...(list(rest['publicKeys']).length + addresses.filter((one) => !isDomain(one)).length > 0 ? { publicKeys: [...list(rest['publicKeys']), ...addresses.filter((one) => !isDomain(one))] } : {}),
    ...(list(rest['names']).length + addresses.filter(isDomain).length > 0 ? { names: [...list(rest['names']), ...addresses.filter(isDomain)] } : {})
  }
}

const text = (/** @type {unknown} */ value) => (typeof value === 'number' ? String(value) : '')

/**
 * The inputs for a rule.
 * @param {Record<string, any>} given @param {(index: number) => string} keyOfIndex the key of the challenge a rule names by its place
 * @returns {Texts}
 */
export function textsOf (given, keyOfIndex) {
  const exclude = current(given)
  const age = typeof exclude['firstCommentTimestamp'] === 'number' ? splitDuration(exclude['firstCommentTimestamp']) : { value: '', unit: 'days' }
  const community = exclude['community'] ?? {}
  const communityAge = typeof community.firstCommentTimestamp === 'number' ? splitDuration(community.firstCommentTimestamp) : { value: '', unit: 'days' }
  return {
    roles: list(exclude['roles']), publicKeys: list(exclude['publicKeys']).join('\n'), names: list(exclude['names']).join('\n'),
    postScore: text(exclude['postScore']), replyScore: text(exclude['replyScore']), postCount: text(exclude['postCount']), replyCount: text(exclude['replyCount']),
    ageValue: age.value, ageUnit: age.unit,
    types: TYPES.filter((type) => exclude['publicationType']?.[type] === true),
    rateLimit: text(exclude['rateLimit']), rateCounts: exclude['rateLimitChallengeSuccess'] === false ? 'failed' : 'passed',
    after: (Array.isArray(exclude['challenges']) ? exclude['challenges'] : []).map((/** @type {number} */ index) => keyOfIndex(index)),
    communityAddresses: list(community.addresses).join('\n'), communityMax: text(community.maxCommentCids), communityPostScore: text(community.postScore),
    communityReplyScore: text(community.replyScore), communityAgeValue: communityAge.value, communityAgeUnit: communityAge.unit
  }
}

const WHOLE = 'Enter a whole number.'
const ABOVE_ZERO = 'Enter a whole number above 0.'

/** @param {string} value @param {boolean} signed @returns {number} NaN when the text is not a whole number (a negative one only when `signed`) */
function whole (value, signed) {
  const trimmed = value.trim()
  return (signed ? /^-?\d+$/ : /^\d+$/).test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : NaN
}

/**
 * The rule a form makes. A rule that names nothing is refused with a message (`errors.rule`), and one whose only condition was a challenge that
 * is gone is dropped (`dropped`), since an empty rule matches nobody.
 * @param {Texts} texts @param {Record<string, any> | undefined} raw the rule as the board had it: fields this page does not edit are kept
 * @param {(key: string) => number} indexOfKey the place of a challenge now, or -1 for one that is gone
 * @returns {{ exclude?: Record<string, any>, errors: Record<string, string>, dropped?: true }}
 */
export function excludeOf (texts, raw, indexOfKey) {
  /** @type {Record<string, string>} */
  const errors = {}
  /** @type {Record<string, any>} */
  const out = { ...raw }
  for (const key of [...KNOWN, ...LEGACY]) delete out[key]
  const keep = (/** @type {Record<string, any>} */ extra) => { for (const [key, value] of Object.entries(extra)) if (value !== undefined) out[key] = value }

  /** @param {string} field @param {string} value @param {boolean} signed @param {string} [message] */
  const number = (field, value, signed, message = WHOLE) => {
    if (value.trim() === '') return undefined
    const parsed = whole(value, signed)
    if (Number.isNaN(parsed)) { errors[field] = message; return undefined }
    return parsed
  }
  /** @param {string} field @param {string} value @param {string} unit */
  const age = (field, value, unit) => {
    if (value.trim() === '') return undefined
    const parsed = whole(value, false)
    if (Number.isNaN(parsed) || parsed < 1) { errors[field] = ABOVE_ZERO; return undefined }
    return toSeconds(String(parsed), unit)
  }

  const keys = words(texts.publicKeys)
  const names = words(texts.names)
  if (keys.some(isDomain)) errors['publicKeys'] = 'A key is not a name: put a name like alice.eth in the names field.'
  if (names.some((name) => !isDomain(name))) errors['names'] = 'A name is a domain like alice.eth: put a key in the keys field.'
  const places = texts.after.map(indexOfKey).filter((index) => index >= 0)
  const typeFlags = { ...raw?.['publicationType'] }
  for (const type of TYPES) { if (texts.types.includes(type)) typeFlags[type] = true; else delete typeFlags[type] }
  const rate = number('rateLimit', texts.rateLimit, false)

  keep({
    roles: texts.roles.length > 0 ? [...texts.roles] : undefined,
    publicKeys: keys.length > 0 && !keys.some(isDomain) ? keys : undefined,
    names: names.length > 0 && !names.some((name) => !isDomain(name)) ? names : undefined,
    postScore: number('postScore', texts.postScore, true), replyScore: number('replyScore', texts.replyScore, true),
    postCount: number('postCount', texts.postCount, false), replyCount: number('replyCount', texts.replyCount, false),
    firstCommentTimestamp: age('ageValue', texts.ageValue, texts.ageUnit),
    publicationType: Object.keys(typeFlags).length > 0 ? typeFlags : undefined,
    rateLimit: rate,
    rateLimitChallengeSuccess: rate === undefined ? undefined : texts.rateCounts === 'failed' ? false : raw?.['rateLimitChallengeSuccess'] === true ? true : undefined,
    challenges: places.length > 0 ? places : undefined
  })

  const communityGiven = [texts.communityAddresses, texts.communityMax, texts.communityPostScore, texts.communityReplyScore, texts.communityAgeValue].some((one) => one.trim() !== '')
  if (communityGiven) {
    const addresses = words(texts.communityAddresses)
    if (addresses.length === 0) errors['communityAddresses'] = 'Give at least one address to check the reputation in.'
    const max = number('communityMax', texts.communityMax, false)
    const postScore = number('communityPostScore', texts.communityPostScore, true)
    const replyScore = number('communityReplyScore', texts.communityReplyScore, true)
    const communityAge = age('communityAgeValue', texts.communityAgeValue, texts.communityAgeUnit)
    if (addresses.length > 0) keep({ community: { addresses, maxCommentCids: max ?? 3, ...(postScore === undefined ? {} : { postScore }), ...(replyScore === undefined ? {} : { replyScore }), ...(communityAge === undefined ? {} : { firstCommentTimestamp: communityAge }) } })
  }

  if (Object.keys(errors).length > 0) return { errors }
  if (Object.keys(out).length === 0) {
    if (texts.after.length > 0) return { errors, dropped: true }
    return { errors: { rule: 'Choose at least one condition for this rule.' } }
  }
  return { exclude: out, errors }
}

const ROLE_WORDS = { owner: 'the owner', admin: 'an admin', moderator: 'a moderator' }
const TYPE_WORDS = { post: 'a post', reply: 'a reply', vote: 'a vote', commentEdit: 'a comment edit', commentModeration: 'a moderator action' }

/** @param {number} count @param {string} one @param {string} many */
const counted = (count, one, many) => `${String(count)} ${count === 1 ? one : many}`

/** @param {string[]} items @param {string} joiner */
const joined = (items, joiner) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1) ?? ''}`)

/** @param {number} seconds */
function durationWords (seconds) {
  const { value, unit } = splitDuration(seconds)
  return `${value} ${value === '1' ? unit.replace(/s$/, '') : unit}`
}

/**
 * What a rule lets through, as a phrase: "a moderator or an admin", "an author with a post score of at least 5".
 * @param {Record<string, any>} given @param {{ term: import('./terms.js').Term, nameOfChallenge: (index: number) => string }} context
 */
export function wordsOfExclude (given, { term, nameOfChallenge }) {
  const exclude = current(given)
  /** @type {string[]} */
  const phrases = []
  const roles = list(exclude['roles'])
  if (roles.length > 0) phrases.push(roles.map((role) => ROLE_WORDS[/** @type {keyof typeof ROLE_WORDS} */ (role)] ?? `a ${role}`).join(' or '))
  const keys = list(exclude['publicKeys'])
  if (keys.length > 0) phrases.push(keys.length === 1 ? `the author with the key ${keys[0] ?? ''}` : `an author with one of these keys: ${keys.join(', ')}`)
  const names = list(exclude['names'])
  if (names.length > 0) phrases.push(names.length === 1 ? `the author named ${names[0] ?? ''}` : `an author with one of these names: ${names.join(', ')}`)

  const traits = [
    typeof exclude['postScore'] === 'number' ? `a post score of at least ${String(exclude['postScore'])}` : '',
    typeof exclude['replyScore'] === 'number' ? `a reply score of at least ${String(exclude['replyScore'])}` : '',
    typeof exclude['postCount'] === 'number' ? `at least ${counted(exclude['postCount'], 'post', 'posts')}` : '',
    typeof exclude['replyCount'] === 'number' ? `at least ${counted(exclude['replyCount'], 'reply', 'replies')}` : ''
  ].filter((one) => one !== '')
  const age = typeof exclude['firstCommentTimestamp'] === 'number' ? `whose first comment is at least ${durationWords(exclude['firstCommentTimestamp'])} old` : ''
  if (traits.length > 0 || age !== '') phrases.push(`an author${traits.length > 0 ? ` with ${traits.join(' and ')}` : ''}${age === '' ? '' : `${traits.length > 0 ? ', ' : ' '}${age}`}`)

  const flagged = TYPES.filter((type) => exclude['publicationType']?.[type] === true)
  const kind = flagged.length === 0 ? '' : `when the publication is ${flagged.map((type) => (type === 'communityEdit' ? `a change to the ${term.board}` : TYPE_WORDS[type])).join(' or ')}`
  const rate = typeof exclude['rateLimit'] === 'number' ? `up to ${counted(exclude['rateLimit'], 'publication', 'publications')} an hour (counting the ones that ${exclude['rateLimitChallengeSuccess'] === false ? 'failed' : 'passed'} their challenges)` : ''
  if (kind !== '' || rate !== '') phrases.push([kind, rate].filter((one) => one !== '').join(', '))

  const passed = (Array.isArray(exclude['challenges']) ? exclude['challenges'] : []).map((/** @type {number} */ index) => nameOfChallenge(index))
  if (passed.length > 0) phrases.push(`an author who passed the challenge${passed.length === 1 ? '' : 's'} ${joined(passed, 'and')}`)

  const community = exclude['community']
  if (community !== undefined && community !== null) {
    const there = [
      typeof community.postScore === 'number' ? `a post score of at least ${String(community.postScore)}` : '',
      typeof community.replyScore === 'number' ? `a reply score of at least ${String(community.replyScore)}` : ''
    ].filter((one) => one !== '')
    const where = joined(list(community.addresses), 'or')
    const old = typeof community.firstCommentTimestamp === 'number' ? `whose first comment there is at least ${durationWords(community.firstCommentTimestamp)} old` : ''
    const who = there.length > 0 ? `an author with ${there.join(' and ')} in ${where}${old === '' ? '' : `, ${old}`}` : old === '' ? `an author who has commented in ${where}` : `an author in ${where} ${old}`
    phrases.push(`${who}, shown by up to ${String(community.maxCommentCids)} of their comments there`)
  }

  const others = Object.keys(exclude).filter((key) => !KNOWN.includes(key))
  if (others.length > 0) phrases.push(`other conditions this page does not show (${others.join(', ')})`)
  return phrases.length === 0 ? 'nobody (this rule sets no condition)' : phrases.join(', and ')
}
