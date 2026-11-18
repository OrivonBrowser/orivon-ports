// "Require an Orivon ID": a pkc-js challenge that lets in an author whose name is an Orivon ID, a name one label under `v1.orivonid.eth`
// (`alice.v1.orivonid.eth`), and refuses everyone else with a message that says where to get one. It holds no check of its own for who owns
// the name: pkc-js's author-identity matcher resolves the name through the node's name resolvers, reads its `bitsocial` text record, and
// matches it against the key that signed the publication, bypassing every cache, which is the check that stops one author claiming another's
// name. Only whoever may write the name's records can have set that record, so a match shows that the poster holds the ID and that the ID
// stands for this key.

export const NAME = '@orivon/id-challenge'
/** The registry every Orivon ID lives under. */
export const PARENT = 'v1.orivonid.eth'
/** Where a person gets an ID. */
export const SITE = 'https://id.orivonstack.eth'
export const DEFAULT_MESSAGE = `Posting here needs an Orivon ID: get one at ${SITE}, give it a "bitsocial" record that holds your author address, and post under that name.`
const MAX_MESSAGE = 500

/** One label of the characters the registrar sells (3 to 63 of a to z, 0 to 9 and "-", no "-" at either end), then the parent. */
const SHAPE = /^([a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9])\.v1\.orivonid\.eth$/

/**
 * The ID an author name stands for, or null when the name is not one. Exactly one label sits under the parent: an ID holder can mint names
 * below their own, and each would be a voice more than the one ID. Only ASCII is folded to lower case, because a full lower-casing turns a
 * Kelvin sign into a "k"; `.bso` is the protocol's other spelling of `.eth`. `.orv` is not accepted: no Bitsocial node resolves it.
 * @param {unknown} name
 * @returns {{ label: string, name: string } | null}
 */
export function orivonIdOf (name) {
  if (typeof name !== 'string') return null
  const folded = name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const spelled = folded.endsWith('.bso') ? `${folded.slice(0, -4)}.eth` : folded
  const found = SHAPE.exec(spelled)
  return found === null ? null : { label: /** @type {string} */ (found[1]), name: spelled }
}

/**
 * @typedef {object} IdentityMatcher what pkc-js hands a challenge to ask who an author is (`authorIdentityMatcher`)
 * @property {string | undefined} wireName the name the publication's author wrote
 * @property {(name: string) => Promise<{ matched: boolean, nameFailure?: { reason: string } }>} matchesIdentity whether the name resolves to the signer
 */

/**
 * @typedef {object} Request what pkc-js hands `getChallenge`
 * @property {{ name?: string, options?: Record<string, unknown> }} challengeSettings the board's entry for this challenge
 * @property {unknown} [challengeRequestMessage]
 * @property {IdentityMatcher} [authorIdentityMatcher]
 */

/** @param {string} message the board's message */
const refused = (message) => ({ success: false, error: message, reason: message })

/** @param {Record<string, unknown> | undefined} options @returns {string} the message a refused poster reads: the board owner's, or the default */
const messageOf = (options) => {
  const own = options?.['error']
  return typeof own === 'string' && own.trim() !== '' ? own : DEFAULT_MESSAGE
}

/**
 * @param {Request} request
 * @returns {Promise<{ success: boolean, error?: string, reason?: string }>}
 */
async function getChallenge ({ challengeSettings, authorIdentityMatcher }) {
  const message = messageOf(challengeSettings?.options)
  if (authorIdentityMatcher === undefined || orivonIdOf(authorIdentityMatcher.wireName) === null) return refused(message)
  try {
    const verdict = await authorIdentityMatcher.matchesIdentity(/** @type {string} */ (authorIdentityMatcher.wireName))
    if (verdict.matched) return { success: true }
    return refused(verdict.nameFailure === undefined ? `${message} That name's "bitsocial" record holds a different address.` : `${message} ${verdict.nameFailure.reason}`)
  } catch {
    return refused(message)
  }
}

/** @type {Array<{ option: string, label: string, default: string, description: string, placeholder: string, required?: boolean }>} */
const optionInputs = [{
  option: 'error',
  label: 'Message',
  default: DEFAULT_MESSAGE,
  description: 'What a poster without an Orivon ID is told. Empty: the default.',
  placeholder: DEFAULT_MESSAGE
}]

/** pkc-js asks this when a board's settings are edited, so a bad message is refused there and not at the first post. @param {{ challengeSettings?: Request['challengeSettings'] }} settings */
function validateChallengeSettings ({ challengeSettings }) {
  const own = challengeSettings?.options?.['error']
  if (own === undefined) return
  if (typeof own !== 'string') throw new Error('the message must be text')
  if (own.length > MAX_MESSAGE) throw new Error(`the message is at most ${String(MAX_MESSAGE)} characters`)
  if (/[\r\n]/.test(own)) throw new Error('the message is one line')
}

/** The factory pkc-js registers under `NAME`. @param {{ challengeSettings?: unknown }} [_settings] */
export default function OrivonIdChallengeFactory (_settings) {
  return {
    getChallenge,
    optionInputs,
    type: 'text/plain',
    description: `Require an Orivon ID: the author's name must be one label under ${PARENT}, and its "bitsocial" record must hold the key that signed.`,
    validateChallengeSettings
  }
}
