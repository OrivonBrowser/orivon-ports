// What a file under apps/ may be. Separate from check-no-upstream.ts so the
// rule can be tested without the gate running on import.

/**
 * Everything a port is allowed to be. It is an allowlist rather than a
 * heuristic because the thing being prevented -- somebody's AGPL source
 * landing in a public repository -- is not a thing to catch nine times in ten.
 */
const PORT_FILES = [
  /^apps\/[a-z0-9-]+\/recipe\.json$/,
  /^apps\/[a-z0-9-]+\/orivon\.json$/,
  /^apps\/[a-z0-9-]+\/README\.md$/,
  /^apps\/[a-z0-9-]+\/UPSTREAM\.md$/,
  /^apps\/[a-z0-9-]+\/hooks\.mjs$/,
  /^apps\/[a-z0-9-]+\/[a-z0-9.-]*config\.(?:cjs|mjs|js)$/,
  /^apps\/[a-z0-9-]+\/bridge\/[a-zA-Z0-9.-]+\.(?:js|ts)$/,
  // A member declaration (src/bridge/): ours, written from the app's call
  // sites, holding no code of theirs.
  /^apps\/[a-z0-9-]+\/bridge\/members\.json$/
]

/**
 * Inside a recipe's `site` directory, the text formats a person writes by
 * hand. A font or an image is what somebody else's work looks like when it
 * is dropped into a directory that is otherwise ours, so it stays out here
 * as it does everywhere else under apps/.
 */
const SITE_FILE = /\.(?:html|css|js|svg)$/

/** `sites` holds each site directory as a repository path, e.g. `apps/x/site`. */
export function isAllowedAppFile (path: string, sites: readonly string[]): boolean {
  if (PORT_FILES.some((pattern) => pattern.test(path))) return true
  return SITE_FILE.test(path) && sites.some((site) => path.startsWith(`${site.replace(/\/+$/, '')}/`))
}
