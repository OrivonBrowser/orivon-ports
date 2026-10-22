// How far an app's pin is behind its upstream: the recipe's pinned commit and the newest upstream
// release, each with a date. Pure; the requests are in fetchers.js.

/**
 * The few fields of an app's recipe.json that say where the pin is.
 * @param {string} text
 * @returns {{ repo: string, ref: string, tagPattern: string | null, prerelease: boolean } | null} null for a recipe that is not a port
 */
export function parseRecipe (text) {
  let recipe
  try {
    recipe = JSON.parse(text)
  } catch {
    return null
  }
  const upstream = recipe?.upstream
  const repo = typeof upstream?.repo === 'string' ? repoOf(upstream.repo) : null
  if (!repo || !/^[0-9a-f]{40}$/.test(String(upstream.ref))) return null
  return { repo, ref: upstream.ref, tagPattern: typeof upstream.tagPattern === 'string' ? upstream.tagPattern : null, prerelease: upstream.prerelease === true }
}

/**
 * Whether the recipe pins a commit of a repository outside GitHub (Arti is on the Tor Project's
 * GitLab): the page asks only GitHub, so such a pin is not checked rather than wrong.
 * @param {string} text
 * @returns {boolean}
 */
export function pinnedElsewhere (text) {
  let upstream
  try {
    upstream = JSON.parse(text)?.upstream
  } catch {
    return false
  }
  return typeof upstream?.repo === 'string' && /^https:\/\//.test(upstream.repo) && repoOf(upstream.repo) === null && /^[0-9a-f]{40}$/.test(String(upstream.ref))
}

/**
 * `owner/name` of a GitHub repository URL.
 * @param {string} url
 * @returns {string | null}
 */
export function repoOf (url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url)
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * The newest release that counts: not a draft, not a pre-release unless the recipe says upstream
 * publishes its releases that way, and a tag the recipe's pattern accepts.
 * @param {any[]} releases the GitHub API's release objects
 * @param {{ tagPattern: string | null, prerelease: boolean }} rules
 * @returns {{ tag: string, date: Date, url: string } | null}
 */
export function chooseRelease (releases, rules) {
  let pattern = null
  try {
    pattern = rules.tagPattern === null ? null : new RegExp(rules.tagPattern)
  } catch {
    return null
  }
  const counted = releases
    .filter((release) => release && !release.draft && (rules.prerelease || !release.prerelease) && (pattern === null || pattern.test(String(release.tag_name))))
    .map((release) => ({ tag: String(release.tag_name), date: new Date(release.published_at ?? release.created_at), url: String(release.html_url ?? '') }))
    .filter((release) => !Number.isNaN(release.date.getTime()))
  return counted.reduce((newest, release) => (newest === null || release.date > newest.date ? release : newest), /** @type {{ tag: string, date: Date, url: string } | null} */ (null))
}

const DAY_MS = 24 * 60 * 60 * 1000

/** @param {Date} date */
const day = (date) => date.toISOString().slice(0, 10)

/**
 * The pin against the newest release, in words and in whole days.
 * @param {Date} pinned the pinned commit's date
 * @param {{ tag: string, date: Date } | null} release
 * @returns {{ pinned: string, release: string | null, days: number | null, relation: 'behind' | 'level' | 'ahead' | 'unknown' }}
 */
export function pinAge (pinned, release) {
  if (!release) return { pinned: day(pinned), release: null, days: null, relation: 'unknown' }
  const days = Math.round((release.date.getTime() - pinned.getTime()) / DAY_MS)
  return { pinned: day(pinned), release: `${release.tag}, ${day(release.date)}`, days, relation: days > 0 ? 'behind' : days < 0 ? 'ahead' : 'level' }
}

/**
 * @param {ReturnType<typeof pinAge>} age
 * @returns {string} the second line of the cell: how the pin sits against the release
 */
export function describeAge (age) {
  if (age.relation === 'unknown') return 'upstream has no stable release'
  const days = Math.abs(/** @type {number} */ (age.days))
  const span = `${days} day${days === 1 ? '' : 's'}`
  if (age.relation === 'behind') return `the pin is ${span} older than the newest release`
  if (age.relation === 'ahead') return `the pin is ${span} newer than the newest release`
  return 'the pin and the newest release are from the same day'
}
