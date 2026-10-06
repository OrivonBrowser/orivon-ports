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
 * A port whose upstream is a server has no `site/`: the page that starts the
 * server and shows what it serves is ours, and lives in `launcher/`. The same
 * reason as SITE_FILE bounds it, so a font or an image, which is somebody
 * else's work, stays out. A launcher's unit tests are ours too (`.test.ts`,
 * like a bridge's), and it is one flat directory.
 */
const LAUNCHER_FILE = /^apps\/[a-z0-9-]+\/launcher\/[a-zA-Z0-9.-]+\.(?:html|css|js|svg|test\.ts)$/

/**
 * A site's unit tests are ours too, and they sit beside the site rather than
 * in it, so the served tree and anything published from it never carry them.
 */
const SITE_TEST_FILE = /^apps\/[a-z0-9-]+\/test\/[a-zA-Z0-9.-]+\.test\.ts$/

/**
 * Inside a recipe's `site` directory, the text formats a person writes by
 * hand. A font or an image is what somebody else's work looks like when it
 * is dropped into a directory that is otherwise ours, so it stays out here
 * as it does everywhere else under apps/.
 */
const SITE_FILE = /\.(?:html|css|js|svg)$/

/**
 * The one image exception, and it names its app: Explore's cards show each
 * listed site's own icon, a mark that is the site's and is shown only to name
 * it. One flat directory of PNGs; apps/explore/UPSTREAM.md says where each
 * came from.
 */
const DIRECTORY_ICON = /^apps\/explore\/site\/icons\/[a-z0-9-]+\.png$/

/** `sites` holds each site directory as a repository path, e.g. `apps/x/site`. */
export function isAllowedAppFile (path: string, sites: readonly string[]): boolean {
  if (PORT_FILES.some((pattern) => pattern.test(path)) || LAUNCHER_FILE.test(path) || SITE_TEST_FILE.test(path)) return true
  if (DIRECTORY_ICON.test(path)) return true
  return SITE_FILE.test(path) && sites.some((site) => path.startsWith(`${site.replace(/\/+$/, '')}/`))
}
