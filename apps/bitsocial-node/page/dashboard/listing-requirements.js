// What a board must publish in its own record to be listed in a 5chan directory, and whether it does. The settings checked are the
// ones 5chan itself checks before it lets a board host a directory (a listing that 5chan would pass over is not worth asking for):
// the directory's poster-ID mode, safe-for-work flag and media-only thread links, no galleries, a challenge that holds a new poster
// for approval, and the directory's rules, which a board lists first and in order. Whether a board keeps its rules, stays online
// and archives is not in the record, so it is not checked here.

/** @typedef {{ type: 'pseudonymityMode', mode: string } | { type: 'safeForWork', safeForWork: boolean } | { type: 'requirePostLinkIsMedia' } | { type: 'noGallery' } | { type: 'pendingApproval' } | { type: 'rules', rules: string[] }} Requirement */
/** @typedef {{ features?: unknown, challenges?: unknown, rules?: unknown }} BoardRecord */

const isRecord = (/** @type {unknown} */ value) => typeof value === 'object' && value !== null

/** A board takes galleries when either limit is above 0; unset or 0 keeps them off. */
const isGalleryLimit = (/** @type {unknown} */ value) => typeof value === 'number' && value > 0

const MODE_WORDS = /** @type {Record<string, string>} */ ({
  'per-post': 'Poster IDs that last for one thread',
  'per-reply': 'No poster IDs: every reply comes from a new address',
  'per-author': 'Poster IDs that stay the same for each author'
})

/**
 * The requirements of a directory, from its entry in the lists' defaults file.
 * @param {{ features?: unknown, rules?: unknown }} [directory]
 * @returns {Requirement[]}
 */
export function requirementsOf (directory) {
  const features = isRecord(directory?.features) ? /** @type {Record<string, unknown>} */ (directory?.features) : {}
  const rules = Array.isArray(directory?.rules) ? directory.rules.filter((/** @type {unknown} */ rule) => typeof rule === 'string' && rule.length > 0) : []
  return [
    ...(typeof features['pseudonymityMode'] === 'string' ? [{ type: /** @type {const} */ ('pseudonymityMode'), mode: features['pseudonymityMode'] }] : []),
    ...(typeof features['safeForWork'] === 'boolean' ? [{ type: /** @type {const} */ ('safeForWork'), safeForWork: features['safeForWork'] }] : []),
    ...(features['requirePostLinkIsMedia'] === true ? [{ type: /** @type {const} */ ('requirePostLinkIsMedia') }] : []),
    { type: 'noGallery' },
    { type: 'pendingApproval' },
    ...(rules.length > 0 ? [{ type: /** @type {const} */ ('rules'), rules }] : [])
  ]
}

/** @param {Requirement} requirement @param {BoardRecord} record */
function meets (requirement, record) {
  const features = isRecord(record.features) ? /** @type {Record<string, unknown>} */ (record.features) : {}
  switch (requirement.type) {
    case 'pseudonymityMode': return features['pseudonymityMode'] === requirement.mode
    // An NSFW directory only asks a board not to claim it is safe for work.
    case 'safeForWork': return requirement.safeForWork ? features['safeForWork'] === true : features['safeForWork'] !== true
    case 'requirePostLinkIsMedia': return features['requirePostLinkIsMedia'] === true
    case 'noGallery': return !isGalleryLimit(features['maxPostGalleryItems']) && !isGalleryLimit(features['maxReplyGalleryItems'])
    case 'pendingApproval': return Array.isArray(record.challenges) && record.challenges.some((one) => isRecord(one) && one.pendingApproval === true)
    case 'rules': {
      const own = record.rules
      return Array.isArray(own) && requirement.rules.every((rule, index) => typeof own[index] === 'string' && own[index].trim() === rule.trim())
    }
  }
}

/** @param {Requirement[]} requirements @param {BoardRecord} record the requirements the record misses, in the directory's order */
export const unmetOf = (requirements, record) => requirements.filter((requirement) => !meets(requirement, record))

/** @param {Requirement[]} requirements @param {BoardRecord | null | undefined} record `unknown` until the board has published a record @returns {'eligible' | 'ineligible' | 'unknown'} */
export function eligibilityOf (requirements, record) {
  if (record === undefined || record === null) return 'unknown'
  return unmetOf(requirements, record).length === 0 ? 'eligible' : 'ineligible'
}

/** What a requirement asks, in a board owner's words. @param {Requirement} requirement */
export function wordsOf (requirement) {
  switch (requirement.type) {
    case 'pseudonymityMode': return MODE_WORDS[requirement.mode] ?? `Poster IDs set to "${requirement.mode}"`
    case 'safeForWork': return requirement.safeForWork ? 'The board is marked safe for work' : 'The board is not marked safe for work'
    case 'requirePostLinkIsMedia': return 'A thread must link to a picture or a video'
    case 'noGallery': return 'Every post is a single file, never a gallery'
    case 'pendingApproval': return 'A new poster waits for a moderator to approve the first posts'
    case 'rules': return "The directory's rules come first in the board's rules, word for word"
  }
}

/** The setting to change to meet a requirement, as the board's record spells it. @param {Requirement} requirement */
export function fixOf (requirement) {
  switch (requirement.type) {
    case 'pseudonymityMode': return `features.pseudonymityMode: ${requirement.mode}`
    case 'safeForWork': return `features.safeForWork: ${String(requirement.safeForWork)}`
    case 'requirePostLinkIsMedia': return 'features.requirePostLinkIsMedia: true'
    case 'noGallery': return 'features.maxPostGalleryItems, features.maxReplyGalleryItems: 0'
    case 'pendingApproval': return 'one challenge with pendingApproval: true'
    case 'rules': return requirement.rules.length === 1 ? 'rules[0]' : `rules[0..${String(requirement.rules.length - 1)}]`
  }
}
