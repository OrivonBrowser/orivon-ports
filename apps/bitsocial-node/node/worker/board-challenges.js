// A board's anti-spam challenges, for a page that edits them: the boards this node hosts, one board's challenges, and a new list applied by
// reading the board's settings, replacing `challenges` alone and writing the whole back, because an edit replaces `settings` whole (a patch of
// `challenges` alone would drop `pages` and every other setting). The reading and the writing are the RPC server's own (`rpc-server.js`);
// pkc-js validates the list and refuses it as a whole, so a refused apply changes nothing.

/** More than this is not a board's list of challenges. */
const CHALLENGES_MAX = 100

export class NotHostedError extends Error {
  /** @param {string} address */
  constructor (address) { super(`${address} is not a board this node hosts`); this.name = 'NotHostedError' }
}

export class ConflictError extends Error {
  constructor () { super('The board\'s challenges changed since you read them.'); this.name = 'ConflictError' }
}

/** What pkc-js refused, or what the page sent that is not a list of challenges; `failures` says which challenge and which option. */
export class SettingsError extends Error {
  /** @param {string} message @param {Array<{ index: number, name: string, option: string | null, message: string }>} [failures] */
  constructor (message, failures = []) { super(message); this.name = 'SettingsError'; this.failures = failures }
}

/** @param {unknown} value @returns {unknown} the same value with the keys of every object in order, so two spellings of one list compare equal */
function ordered (value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(/** @type {any} */ (value)[key])]))
}
const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))

/** @param {string} name the package name `bitsocial challenge install` registers, or any other name or path */
const shortName = (name) => name.replace(/^@bitsocial\//, '').replace(/-challenge$/, '')

/** What one challenge's failure says, from pkc-js's code and details. @param {any} error @returns {{ message: string, option: string | null }} */
function failureWords (error) {
  const details = error?.details ?? {}
  switch (error?.code) {
    case 'ERR_CHALLENGE_REQUIRED_OPTION_MISSING': return { message: `a required option is missing: ${String(details.missingOption)}`, option: String(details.missingOption) }
    case 'ERR_CHALLENGE_OPTION_NOT_DECLARED_IN_OPTION_INPUTS': return { message: `the option ${String(details.offendingOption)} is not one this challenge has`, option: String(details.offendingOption) }
    case 'ERR_CHALLENGE_PUBLIC_OPTION_NOT_DECLARED_IN_OPTION_INPUTS': return { message: `the option ${String(details.offendingOption)} cannot be published: this challenge has no such option`, option: String(details.offendingOption) }
    case 'ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED': return { message: typeof details.validationError === 'string' ? details.validationError : String(error.message), option: null }
    default: return { message: String(error?.message ?? error), option: null }
  }
}

/** The first things schema validation named, as `path: message`. @param {any} zodError */
function schemaWords (zodError) {
  const issues = Array.isArray(zodError?.issues) ? zodError.issues.slice(0, 3) : []
  return issues.map((/** @type {{ path?: unknown[], message?: string }} */ issue) => `${(issue.path ?? []).join('.')}: ${String(issue.message)}`).join('; ')
}

/** pkc-js's refusal of a write as a SettingsError; an error that is not pkc-js's is returned as it is. @param {any} error */
function asSettingsError (error) {
  if (typeof error?.code !== 'string' || !error.code.startsWith('ERR_')) return error
  const failures = (Array.isArray(error.details?.failures) ? error.details.failures : []).map((/** @type {any} */ failure) => {
    const { message, option } = failureWords(failure.error)
    return { index: Number(failure.challengeIndex), name: String(failure.challengeName ?? ''), option, message }
  })
  if (failures.length === 0) {
    const schema = schemaWords(error.details?.zodError)
    return new SettingsError(`${String(error.message)}${schema === '' ? '' : ` (${schema})`}`)
  }
  const text = failures.map((/** @type {{ index: number, name: string, message: string }} */ one) => `Challenge ${String(one.index + 1)} (${shortName(one.name)}): ${one.message.replace(/\.$/, '')}.`).join(' ')
  return new SettingsError(text, failures)
}

/** @param {unknown} list @returns {Array<Record<string, unknown>>} */
function checked (list) {
  if (!Array.isArray(list)) throw new SettingsError('The challenges must be a list.')
  if (list.length > CHALLENGES_MAX) throw new SettingsError(`A board takes at most ${String(CHALLENGES_MAX)} challenges.`)
  for (const [index, entry] of list.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SettingsError(`Challenge ${String(index + 1)} is not a challenge entry.`)
    const named = /** @type {Record<string, unknown>} */ (entry)
    if (typeof named['name'] !== 'string' && typeof named['path'] !== 'string') throw new SettingsError(`Challenge ${String(index + 1)} has no name.`)
  }
  return /** @type {Array<Record<string, unknown>>} */ (list)
}

/**
 * @param {{
 *   hosted: () => Array<{ address: string, name?: string | null, publicKey?: string | null, started?: boolean }>,
 *   read: (address: string) => Promise<Record<string, unknown>>,
 *   edit: (address: string, settings: Record<string, unknown>) => Promise<Record<string, unknown> | null | undefined>
 * }} server `read` answers a hosted board's current settings; `edit` writes the whole `settings` and answers what was saved
 */
export function boardChallenges ({ hosted, read, edit }) {
  /** @param {string} address */
  function mustHost (address) {
    if (!hosted().some((one) => one.address === address)) throw new NotHostedError(address)
  }

  /** @param {string} address @param {Record<string, unknown>} settings */
  function view (address, settings) {
    const list = Array.isArray(settings['challenges']) ? settings['challenges'] : []
    return { address, challenges: structuredClone(list), otherSettings: Object.keys(settings).filter((key) => key !== 'challenges').sort() }
  }

  return {
    boards () {
      const boards = hosted().map((one) => ({ address: one.address, ...(typeof one.name === 'string' ? { name: one.name } : {}), ...(typeof one.publicKey === 'string' ? { publicKey: one.publicKey } : {}), started: one.started === true }))
      return { boards: boards.sort((a, b) => a.address.localeCompare(b.address)) }
    },

    /** @param {string} address */
    async board (address) {
      mustHost(address)
      return view(address, await read(address))
    },

    /**
     * Sets the board's challenges to `challenges`, and every other setting stays as it was read. `expect`, when given, is the list the caller
     * read: a board whose list is another one by now is refused, so an apply never overwrites a change it has not seen.
     * @param {string} address @param {unknown} challenges @param {unknown} [expectList]
     */
    async apply (address, challenges, expectList) {
      const next = checked(challenges)
      mustHost(address)
      const current = await read(address)
      const have = Array.isArray(current['challenges']) ? current['challenges'] : []
      if (expectList !== undefined && !same(expectList, have)) throw new ConflictError()
      if (same(next, have)) return view(address, current)
      const merged = { ...structuredClone(current), challenges: structuredClone(next) }
      /** @type {Record<string, unknown> | null | undefined} */
      let saved
      try { saved = await edit(address, merged) } catch (error) { throw asSettingsError(error) }
      return view(address, saved ?? merged)
    }
  }
}
