// The developer-approved mark: which listings may show it, and what it links to. A pure module, so
// the page and the catalog test read the same rule.

/**
 * A GitHub conversation: an issue, a discussion or a pull request, optionally at one comment.
 * Owner and repository names are GitHub's own character set.
 */
const GITHUB_THREAD = /^\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/(?:issues|discussions|pull)\/\d+\/?$/
const X_POST = /^\/[A-Za-z0-9_]{1,15}\/status\/\d+\/?$/
const GITHUB_COMMENT = /^#(?:issuecomment|discussioncomment|pullrequestreview|discussion_r)-?\d+$/

/** @param {string} host @param {string} upstreamHost */
function onProjectHost (host, upstreamHost) {
  const base = upstreamHost.replace(/^www\./, '')
  return host === base || host === `www.${base}` || host.endsWith(`.${base}`)
}

/**
 * Why a listing's `approval` is not acceptable, or null when it is absent or sound. What the
 * developers approve is the listing, so it must be the https address of their own public reply:
 * a GitHub issue, discussion or pull request, a post on X (`x.com/<user>/status/<id>`), or a page
 * on the project's own site (the host of `orivon.upstream` for a port, or of `web` for a site,
 * or a subdomain of it, such as its forum). A port and a plain site follow the same rule.
 * @param {import('./catalog.js').Site} site
 * @returns {string | null}
 */
export function approvalProblem (site) {
  const approval = site.approval
  if (approval === undefined) return null
  const url = approval.url
  if (typeof url !== 'string' || url !== url.trim()) return 'approval.url must be a string without spaces around it'
  let parsed
  try { parsed = new URL(url) } catch { return 'approval.url is not a URL' }
  if (parsed.protocol !== 'https:') return 'approval.url must be https'
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return 'approval.url must not carry credentials or a port'
  if (parsed.search !== '') return 'approval.url must not carry a query string'
  if (parsed.hostname === 'github.com') {
    if (!GITHUB_THREAD.test(parsed.pathname)) return 'approval.url on GitHub must be an issue, discussion or pull request'
    if (parsed.hash !== '' && !GITHUB_COMMENT.test(parsed.hash)) return 'approval.url may only point at one comment of the thread'
    return null
  }
  if (parsed.hostname === 'x.com') {
    if (!X_POST.test(parsed.pathname)) return 'approval.url on X must be a post: x.com/<user>/status/<id>'
    if (parsed.hash !== '') return 'approval.url on X must not carry a fragment'
    return null
  }
  const own = projectUrl(site)
  if (!own) return 'approval.url off GitHub and X needs the project\'s own address (upstream or web) to match against'
  if (!onProjectHost(parsed.hostname, new URL(own).hostname)) return 'approval.url must be on GitHub, on X or on the project\'s own site'
  if (parsed.pathname === '/' || parsed.pathname === '') return 'approval.url must name the page where the developers said it, not the home page'
  return null
}

/** The project's own web address: where a port came from, or a site's own address. @param {import('./catalog.js').Site} site */
function projectUrl (site) {
  return site.orivon?.kind === 'port' ? site.orivon.upstream : site.web
}

/**
 * The mark a card shows: words and the link to the developers' reply, or null. Null for a listing
 * without a sound `approval`, so a mark never appears without the link behind it.
 * @param {import('./catalog.js').Site} site
 * @returns {{ text: string, href: string, title: string } | null}
 */
export function approvalFor (site) {
  const approval = site.approval
  if (!approval || approvalProblem(site) !== null) return null
  return {
    text: `Listing approved by the ${site.name} developers`,
    href: approval.url,
    title: `The ${site.name} developers' own public reply`
  }
}
