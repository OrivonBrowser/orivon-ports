// The only module that touches window.orivon: everything else asks this one, so the page
// works unchanged in any browser. Existence is not a grant; a manifest with no capabilities
// still registers its origin.

/**
 * @typedef {{
 *   id: string, version: string, consentGranularity?: string,
 *   capabilities: Record<string, any>
 * }} Manifest
 * @typedef {{ id: string, origin: string, capability: string, patterns: readonly unknown[], grantedAt: number }} Grant
 * @typedef {{
 *   version: number,
 *   app: {
 *     manifest(): Promise<Manifest>,
 *     grants(): Promise<readonly Grant[]>,
 *     requestGrant(request: { capability: string, patterns?: readonly unknown[] }): Promise<boolean>
 *   }
 * }} OrivonApi
 * @typedef {{ orivon?: unknown }} Scope
 * @typedef {{
 *   inOrivon: boolean, version: number | null, registered: boolean,
 *   manifest: Manifest | null, grants: readonly Grant[], notes: string[]
 * }} Snapshot
 */

/** One short sentence for each error code the capability API can reject with. */
export const ERROR_TEXT = {
  denied: 'The request was refused: this app has not been granted that capability.',
  revoked: 'That permission was revoked.',
  unreachable: 'The other end could not be reached.',
  timeout: 'The operation took too long and was stopped.',
  reset: 'The connection was reset by the other side.',
  closed: 'The handle was already closed.',
  limit: 'A limit was reached.',
  invalid: 'The request was not valid.',
  notFound: 'Nothing was found there.',
  exists: 'That already exists.',
  internal: 'Orivon reported an internal error. On an origin it has not registered, this is expected.',
  unavailable: 'This capability is not available in this build of Orivon.'
}

/**
 * The short human sentence for a rejection, falling back to its own message.
 * @param {unknown} error
 */
export function describeError (error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (Object.hasOwn(ERROR_TEXT, code)) return ERROR_TEXT[/** @type {keyof typeof ERROR_TEXT} */ (code)]
  const message = error instanceof Error ? error.message : ''
  return message || 'Something went wrong, and Orivon gave no reason.'
}

/**
 * The capability API, or null in a browser that is not Orivon.
 * @param {Scope} [scope]
 * @returns {OrivonApi | null}
 */
export function api (scope = globalThis) {
  const candidate = scope.orivon
  if (typeof candidate !== 'object' || candidate === null) return null
  if (!('version' in candidate) || typeof candidate.version !== 'number') return null
  return /** @type {OrivonApi} */ (candidate)
}

/** @param {Scope} [scope] */
export function detect (scope = globalThis) {
  const found = api(scope)
  return { inOrivon: found !== null, version: found?.version ?? null }
}

/**
 * Whether Orivon has registered this origin's manifest, and the manifest if so. An
 * unregistered origin is an ordinary answer, not a failure of the page.
 * @param {Scope} [scope]
 * @returns {Promise<{ registered: boolean, manifest: Manifest | null, reason: string }>}
 */
export async function registration (scope = globalThis) {
  const found = api(scope)
  if (!found) return { registered: false, manifest: null, reason: 'Not running in Orivon.' }
  try {
    return { registered: true, manifest: await found.app.manifest(), reason: '' }
  } catch (error) {
    return { registered: false, manifest: null, reason: describeError(error) }
  }
}

/**
 * What was actually granted, which can be less than the manifest declares. Empty outside
 * Orivon and on an unregistered origin.
 * @param {Scope} [scope]
 * @returns {Promise<readonly Grant[]>}
 */
export async function grants (scope = globalThis) {
  const found = api(scope)
  return found ? await found.app.grants() : []
}

/**
 * Ask for a declared capability. Resolves true only when the user allows it; Orivon
 * answers false for a capability the manifest does not declare.
 * @param {string} capability
 * @param {readonly unknown[]} [patterns]
 * @param {Scope} [scope]
 */
export async function request (capability, patterns, scope = globalThis) {
  const found = api(scope)
  if (!found) return false
  return await found.app.requestGrant(patterns ? { capability, patterns } : { capability })
}

/**
 * Everything the Lab's environment panel shows, gathered once. A failed question is noted
 * and the rest still answer.
 * @param {Scope} [scope]
 * @returns {Promise<Snapshot>}
 */
export async function snapshot (scope = globalThis) {
  const { inOrivon, version } = detect(scope)
  /** @type {Snapshot} */
  const result = { inOrivon, version, registered: false, manifest: null, grants: [], notes: [] }
  if (!inOrivon) return result
  const found = await registration(scope)
  result.registered = found.registered
  result.manifest = found.manifest
  if (!found.registered) result.notes.push(`Manifest: ${found.reason}`)
  try {
    result.grants = await grants(scope)
  } catch (error) {
    result.notes.push(`Grants: ${describeError(error)}`)
  }
  return result
}
