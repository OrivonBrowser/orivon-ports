// GitHub releases and their IPFS folders. The release workflow writes a section "### On IPFS"
// whose text carries `ipfs://<cid>`; that CID is the folder the newest releases must serve.

import { parseCid, cidToString } from './cid.js'

/**
 * The CID in a release body, canonical base32 CIDv1, or null.
 * @param {string | null | undefined} body
 * @returns {string | null}
 */
export function releaseCid (body) {
  const section = /###\s*On IPFS([\s\S]*)$/i.exec(body ?? '')
  const match = section ? /ipfs:\/\/(baf[a-z2-7]{50,})/.exec(section[1] ?? '') : null
  if (!match) return null
  try {
    return cidToString(parseCid(/** @type {string} */ (match[1])))
  } catch {
    return null
  }
}

/**
 * What to do with each release, newest first as GitHub lists them. Drafts are dropped. The
 * newest `keep` releases that carry a CID are 'check'; older ones with a CID are 'old'. A
 * release with packages but no CID failed its IPFS step; one with neither is a placeholder.
 * @param {any[]} list the GitHub API's release objects
 * @param {number} keep
 */
export function classifyReleases (list, keep) {
  let checked = 0
  return list.filter((release) => !release.draft).map((release) => {
    const cid = releaseCid(release.body)
    const assets = Array.isArray(release.assets) ? release.assets.length : 0
    /** @type {'check' | 'old' | 'failed' | 'placeholder'} */
    let plan = 'placeholder'
    if (cid) plan = checked++ < keep ? 'check' : 'old'
    else if (assets > 0) plan = 'failed'
    return { tag: String(release.tag_name), url: String(release.html_url), published: String(release.published_at ?? release.created_at), cid, assets, plan }
  })
}

/** The words a release that is not checked gets. @param {'old' | 'failed' | 'placeholder'} plan @param {number} keep */
export function skippedText (plan, keep) {
  if (plan === 'old') return `Not kept (only the newest ${keep} stay pinned)`
  if (plan === 'failed') return 'No packages on IPFS (its release workflow failed)'
  return 'No packages (a placeholder, not a release)'
}

/**
 * The release a record's CID is, by its folder CID.
 * @param {{ tag: string, cid: string | null }[]} releases
 * @param {string | null | undefined} cid
 */
export function releaseOfCid (releases, cid) {
  if (!cid) return null
  let canonical
  try {
    canonical = cidToString(parseCid(cid))
  } catch {
    return null
  }
  return releases.find((release) => release.cid === canonical)?.tag ?? null
}
