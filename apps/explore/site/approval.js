// The developer-approved mark: which ports may show it, and what it links to. A pure module, so
// the page and the catalog test read the same rule.

/**
 * A GitHub conversation: an issue, a discussion or a pull request, optionally at one comment.
 * Owner and repository names are GitHub's own character set.
 */
const GITHUB_THREAD = /^\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/(?:issues|discussions|pull)\/\d+\/?$/
const GITHUB_COMMENT = /^#(?:issuecomment|discussioncomment|pullrequestreview|discussion_r)-?\d+$/

/** @param {string} host @param {string} upstreamHost */
function onProjectHost (host, upstreamHost) {
  const base = upstreamHost.replace(/^www\./, '')
  return host === base || host === `www.${base}` || host.endsWith(`.${base}`)
}

/**
 * Why a site's `approval` is not acceptable, or null when it is absent or sound. It must be the
 * https address of the developers' own public reply: a GitHub issue, discussion or pull request,
 * or a page on the project's own site (the host of `orivon.upstream`, or a subdomain of it, such
 * as its forum). Only a port may carry one.
 * @param {import('./catalog.js').Site} site
 * @returns {string | null}
 */
export function approvalProblem (site) {
  const approval = site.orivon?.approval
  if (approval === undefined) return null
  if (site.orivon?.kind !== 'port') return 'only a port can be approved by its developers'
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
  const upstream = site.orivon?.upstream
  if (!upstream) return 'approval.url off GitHub needs the port\'s upstream project to match against'
  if (!onProjectHost(parsed.hostname, new URL(upstream).hostname)) return 'approval.url must be on GitHub or on the project\'s own site'
  if (parsed.pathname === '/' || parsed.pathname === '') return 'approval.url must name the page where the developers said it, not the home page'
  return null
}

/**
 * The mark a card shows: words and the link to the developers' reply, or null. Null for a port
 * without a sound `approval`, so a mark never appears without the link behind it.
 * @param {import('./catalog.js').Site} site
 * @returns {{ text: string, href: string, title: string } | null}
 */
export function approvalFor (site) {
  const approval = site.orivon?.approval
  if (!approval || approvalProblem(site) !== null) return null
  return {
    text: `Approved by the ${site.name} developers`,
    href: approval.url,
    title: `The ${site.name} developers' own public reply`
  }
}
