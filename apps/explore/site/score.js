// A card's Web2 / Web2.5 / Web3 mark: the Website level Orivon's address bar shows for the
// site, with a Web3 Score provider's judgement applied the way Orivon applies one. Pure.

/**
 * @typedef {1 | 2 | 3 | 4} Level
 * @typedef {'Web2' | 'Web2.5' | 'Web3'} Mark
 * @typedef {{ level: number, provider: string, read: string | null }} Judgement
 *   `read` is the day a snapshot was taken; null for an answer Orivon gave just now
 * @typedef {{ level: Level, mark: Mark, judgement: Judgement | null }} Score
 *   `judgement` is set only when it is what raised the level
 */

/**
 * Level 1 is Web2, Levels 2 and 3 are Web2.5, Level 4 is Web3: the address bar's own words.
 * @param {Level} level
 * @returns {Mark}
 */
export function markOf (level) {
  if (level === 1) return 'Web2'
  return level === 4 ? 'Web3' : 'Web2.5'
}

/**
 * What Orivon observes when it opens the site: Level 2 when it checks every file against an
 * ENS name or an IPFS address, Level 1 at an ordinary web address. Null with no address yet.
 * @param {import('./catalog.js').Site} site
 * @returns {1 | 2 | null}
 */
export function observedLevel (site) {
  if (site.ens || site.ipfs) return 2
  return site.web ? 1 : null
}

/**
 * The identifiers a provider files a website judgement under that this page knows: the CID
 * a site is listed at. A `.eth` name's content changes when its owner publishes, so the page
 * cannot name it; Orivon can, and its answer covers those sites.
 * @param {import('./catalog.js').Site} site
 */
export function identifiersOf (site) {
  return site.ipfs ? [`cid:${site.ipfs}`] : []
}

/**
 * A judgement counts only over Level 2, and only a 3 or a 4 changes what is shown: a judged
 * 1 or 2 says only that 3 and 4 are not met, since Levels 1 and 2 are observed.
 * @param {import('./catalog.js').Site} site
 * @param {Judgement | null} judgement
 * @returns {Score | null}
 */
export function scoreOf (site, judgement) {
  const observed = observedLevel(site)
  if (observed === null) return null
  const raised = observed === 2 && judgement !== null && (judgement.level === 3 || judgement.level === 4)
  const level = /** @type {Level} */ (raised ? judgement.level : observed)
  return { level, mark: markOf(level), judgement: raised ? judgement : null }
}

/**
 * The sentence behind a mark, for its tooltip and its accessible name.
 * @param {Score} score
 */
export function describeScore (score) {
  const head = `Website level ${score.level} (${score.mark})`
  if (score.judgement) {
    const when = score.judgement.read ? ` on ${score.judgement.read}` : ''
    return `${head}, judged by ${score.judgement.provider}${when}`
  }
  return score.level === 1
    ? `${head}: an ordinary web address, so Orivon cannot check what the server sends`
    : `${head}: Orivon checks every file against its ENS name or IPFS address`
}

/**
 * The snapshot's judgement of a site, if the snapshot holds one for an identifier it knows.
 * @param {import('./catalog.js').Site} site
 * @param {{ provider: string, read: string, website: Readonly<Record<string, number>> }} snapshot
 * @returns {Judgement | null}
 */
export function snapshotJudgement (site, snapshot) {
  for (const id of identifiersOf(site)) {
    const level = snapshot.website[id]
    if (level !== undefined) return { level, provider: snapshot.provider, read: snapshot.read }
  }
  return null
}
