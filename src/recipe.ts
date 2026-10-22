// A recipe is the one file a person writes by hand to add a port, so every
// rejection here names the field that is wrong. "Invalid recipe" with no field
// name is what makes a newcomer give up; see README.md's Design notes.
import { shellQuote } from './shell.ts'

export class RecipeError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'RecipeError'
  }
}

export type InjectPoint = 'head-first'

export interface UpstreamSpec {
  readonly repo: string
  readonly ref: string
  readonly licence: string
  /** A regular expression a release tag must match to count as one of this app's releases, for a repository whose tags name more than the app. */
  readonly tagPattern?: string
  /** True when upstream publishes its releases marked pre-release, so the release watcher accepts those. */
  readonly prerelease?: true
  /** True when upstream is a library the app written here is built on, not the app itself: there is no official build of the app to name. */
  readonly library?: true
}

export interface BuildSpec {
  readonly command: string
  readonly output: string
  readonly also?: readonly string[]
}

export interface BridgeSpec {
  /** A bridge script, copied into the served tree as it is. Optional when `members` supplies every member. */
  readonly file?: string
  /** A member declaration the executor composes into the served bridge -- see docs/recipe-format.md. */
  readonly members?: string
  readonly inject: InjectPoint
}

/**
 * What a visitor in another browser is told about this app (src/orivon-hint/).
 * Tier 1 works in any browser; tier 2 needs Orivon to work at all.
 */
export interface HintSpec {
  readonly tier: 1 | 2
  /** The app's name as upstream calls it: the hint writes "A community build by Orivon, not the official <name>". */
  readonly name: string
  /** Upstream's own download or home page. Required beside `upstream`, unless upstream is a library; an app written here has none. */
  readonly officialUrl?: string
  /** One short line added under the hint's own sentence. */
  readonly text?: string
  /** Shown inside Orivon, where the hint is otherwise silent. For a limit the person should know before using the app. */
  readonly notice?: string
}

export interface ExtraFile {
  readonly from: string
  readonly to: string
}

/** The image types Orivon's favicon capture recognises (orivon-mvp's `favicon-format.ts`), by the extension a clone's file carries. */
const ICON_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}

interface RecipeCommon {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly manifest: string
  readonly entry: string
  readonly bridge?: BridgeSpec
  readonly extraFiles: readonly ExtraFile[]
  readonly hooks?: string
  /** A fake `.eth` name a PAC can steer at this app's port. See docs/recipe-format.md. */
  readonly eth?: string
  /** The Orivon hint's per-app data. Absent means a tier 1 hint named after the recipe. */
  readonly hint?: HintSpec
  /** Served as a website: the manifest ships, but the page names it in no `orivon-manifest` link, so Orivon never installs it. */
  readonly website?: true
}

/** Somebody else's app: cloned at a pinned commit and built by its own toolchain. */
export interface PortRecipe extends RecipeCommon {
  readonly upstream: UpstreamSpec
  readonly install?: string
  readonly build: BuildSpec
  /** An image in the clone that becomes the tab icon: copied to `iconTarget(recipe)` and named by the entry document's `<link rel="icon">`. */
  readonly icon?: string
}

/** An app written in this repository. There is nothing to fetch and nothing to build. */
export interface SiteRecipe extends RecipeCommon {
  /** The directory, relative to the app directory, that is served as the app. */
  readonly site: string
}

export type Recipe = PortRecipe | SiteRecipe

export function isSite (recipe: Recipe): recipe is SiteRecipe {
  return 'site' in recipe
}

/** Where the tab icon lands in the served tree. The id keeps it apart from the app's own files, and the extension is the clone file's. */
export function iconTarget (recipe: { readonly id: string, readonly icon: string }): string {
  return `orivon/${recipe.id}-icon${extensionOf(recipe.icon)}`
}

/** The `type` the icon's `<link>` carries. */
export function iconMimeType (icon: string): string {
  return ICON_TYPES[extensionOf(icon)] ?? 'image/png'
}

function extensionOf (path: string): string {
  const dot = path.lastIndexOf('.')
  return dot <= path.lastIndexOf('/') ? '' : path.slice(dot).toLowerCase()
}

export interface RecipeDirs {
  readonly recipe: string
  readonly source: string
  readonly static: string
}

const ID = /^[a-z0-9][a-z0-9-]*$/
const FULL_SHA = /^[0-9a-f]{40}$/
const ETH_NAME = /^(?:[a-z0-9][a-z0-9-]*\.)+eth$/
const MIN_UNPRIVILEGED_PORT = 1024
const MAX_PORT = 65535

const TOP_LEVEL_KEYS = ['id', 'name', 'port', 'upstream', 'install', 'build', 'manifest', 'entry', 'bridge', 'extraFiles', 'hooks', 'icon', 'eth', 'site', 'hint', 'website']
// A site is served as it is written, so every field that fetches, builds or
// patches something has nothing to act on beside it.
const PORT_ONLY_KEYS = ['upstream', 'install', 'build', 'bridge', 'extraFiles', 'hooks', 'icon']
const UPSTREAM_KEYS = ['repo', 'ref', 'licence', 'tagPattern', 'prerelease', 'library']
const BUILD_KEYS = ['command', 'output', 'also']
const BRIDGE_KEYS = ['file', 'members', 'inject']
const HINT_KEYS = ['tier', 'name', 'officialUrl', 'text', 'notice']
const HINT_TEXT_LIMIT = 280

function fail (where: string, why: string): never {
  throw new RecipeError(`${where}: ${why}`)
}

function object (value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(where, 'must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${where}.${key}`, `is not a recipe field -- expected one of: ${allowed.join(', ')}`)
  }
  return record
}

function string (record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (value === undefined) fail(`${where}${key}`, 'is required')
  if (typeof value !== 'string' || value.trim() === '') fail(`${where}${key}`, 'must be a non-empty string')
  return value
}

function optionalString (record: Record<string, unknown>, key: string, where: string): string | undefined {
  return record[key] === undefined ? undefined : string(record, key, where)
}

/**
 * A path joined onto a directory we own. One that climbs out of it writes into
 * the repository, or anywhere else on the disk the process can reach.
 */
function containedPath (record: Record<string, unknown>, key: string, where: string): string {
  const value = string(record, key, where)
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) fail(`${where}${key}`, `must be relative, not "${value}"`)
  if (value.split(/[/\\]/).includes('..')) fail(`${where}${key}`, `must not climb out of its directory: "${value}"`)
  return value
}

/** `build.output` is emptied before every build, so it must name a directory below the source root, never the root itself. */
function buildOutput (record: Record<string, unknown>, where: string): string {
  const value = containedPath(record, 'output', where)
  if (value.split(/[/\\]/).every((part) => part === '' || part === '.')) fail(`${where}output`, `must name a directory below the source root, not "${value}"`)
  return value
}

function hintText (record: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = optionalString(record, key, where)
  if (value !== undefined && value.length > HINT_TEXT_LIMIT) fail(`${where}${key}`, `must be ${String(HINT_TEXT_LIMIT)} characters or fewer -- it is a line in a corner, not a page`)
  return value
}

/** `official` is whether the app has an official build to link: a port of an app has one; a site, and an app built here on a library, do not. */
function parseHint (value: unknown, at: string, official: boolean): HintSpec {
  const where = `${at}hint`
  const record = object(value, where, HINT_KEYS)
  const tier = record['tier']
  if (tier !== 1 && tier !== 2) fail(`${where}.tier`, `must be 1 (works in any browser) or 2 (needs Orivon to work at all) -- got ${JSON.stringify(tier)}`)
  const name = string(record, 'name', `${where}.`)
  const officialUrl = optionalString(record, 'officialUrl', `${where}.`)
  if (officialUrl !== undefined) {
    let protocol = ''
    try { protocol = new URL(officialUrl).protocol } catch { /* not a URL: the message below */ }
    if (protocol !== 'https:') fail(`${where}.officialUrl`, `must be an https:// URL -- got "${officialUrl}"`)
    if (!official) fail(`${where}.officialUrl`, 'cannot sit in a "site" recipe or beside "upstream.library" -- an app written in this repository has no official build to point at')
  } else if (official) {
    fail(`${where}.officialUrl`, 'is required for a port -- the upstream project\'s own download or home page')
  }
  const text = hintText(record, 'text', `${where}.`)
  const notice = hintText(record, 'notice', `${where}.`)
  return {
    tier,
    name,
    ...(officialUrl === undefined ? {} : { officialUrl }),
    ...(text === undefined ? {} : { text }),
    ...(notice === undefined ? {} : { notice })
  }
}

export function parseRecipe (value: unknown, sourcePath: string): Recipe {
  const at = `${sourcePath} `
  const record = object(value, sourcePath, TOP_LEVEL_KEYS)

  const id = string(record, 'id', at)
  if (!ID.test(id)) fail(`${at}id`, `must be lowercase letters, digits and dashes -- "${id}" is not a safe directory name`)

  const port = record['port']
  if (port === undefined) fail(`${at}port`, 'is required')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < MIN_UNPRIVILEGED_PORT || port > MAX_PORT) {
    fail(`${at}port`, `must be a whole number from ${String(MIN_UNPRIVILEGED_PORT)} to ${String(MAX_PORT)} -- got ${String(port)}`)
  }

  const eth = optionalString(record, 'eth', at)
  if (eth !== undefined && !ETH_NAME.test(eth)) {
    fail(`${at}eth`, `must be lowercase labels followed by ".eth" -- "${eth}" is not, e.g. "freetube.orivonstack.eth"`)
  }

  const upstreamValue = record['upstream']
  const library = typeof upstreamValue === 'object' && upstreamValue !== null && (upstreamValue as Record<string, unknown>)['library'] === true
  const hint = record['hint'] === undefined ? undefined : parseHint(record['hint'], at, record['site'] === undefined && !library)

  const website = record['website']
  if (website !== undefined && website !== true) fail(`${at}website`, 'must be true when present -- leave it out for an app Orivon installs')
  if (website === true && record['bridge'] !== undefined) fail(`${at}bridge`, 'cannot sit beside "website" -- Orivon grants a website nothing, so a bridge has no capability to call')

  const common = {
    id,
    name: string(record, 'name', at),
    port,
    manifest: containedPath(record, 'manifest', at),
    entry: optionalString(record, 'entry', at) ?? 'index.html',
    ...(eth === undefined ? {} : { eth }),
    ...(hint === undefined ? {} : { hint }),
    ...(website === true ? { website: true as const } : {})
  }

  if (record['site'] !== undefined) {
    for (const key of PORT_ONLY_KEYS) {
      if (record[key] !== undefined) fail(`${at}${key}`, 'cannot sit beside "site" -- a site is served as it is written, with nothing to fetch, build or patch')
    }
    return { ...common, extraFiles: [], site: containedPath(record, 'site', at) }
  }

  const upstreamRecord = record['upstream'] === undefined
    ? fail(`${at}upstream`, 'is required -- or "site", for an app written in this repository')
    : object(record['upstream'], `${at}upstream`, UPSTREAM_KEYS)
  const repo = string(upstreamRecord, 'repo', `${at}upstream.`)
  if (!repo.startsWith('https://')) fail(`${at}upstream.repo`, `must be an https:// URL -- got "${repo}"`)
  const ref = string(upstreamRecord, 'ref', `${at}upstream.`)
  if (!FULL_SHA.test(ref)) {
    fail(`${at}upstream.ref`, `must be a full 40-character commit sha, not "${ref}" -- a branch or tag makes the build unreproducible`)
  }

  const tagPattern = optionalString(upstreamRecord, 'tagPattern', `${at}upstream.`)
  if (tagPattern !== undefined) {
    try { new RegExp(tagPattern) } catch { fail(`${at}upstream.tagPattern`, `must be a regular expression -- "${tagPattern}" is not one`) }
  }
  const prerelease = upstreamRecord['prerelease']
  if (prerelease !== undefined && prerelease !== true) fail(`${at}upstream.prerelease`, 'must be true when present -- leave it out to skip pre-releases')
  if (upstreamRecord['library'] !== undefined && upstreamRecord['library'] !== true) fail(`${at}upstream.library`, 'must be true when present -- leave it out when upstream is the app itself')

  const buildRecord = record['build'] === undefined
    ? fail(`${at}build`, 'is required')
    : object(record['build'], `${at}build`, BUILD_KEYS)
  const also = buildRecord['also']
  if (also !== undefined && (!Array.isArray(also) || also.some((entry) => typeof entry !== 'string'))) {
    fail(`${at}build.also`, 'must be an array of shell commands')
  }

  const bridgeValue = record['bridge']
  let bridge: BridgeSpec | undefined
  if (bridgeValue !== undefined) {
    const bridgeRecord = object(bridgeValue, `${at}bridge`, BRIDGE_KEYS)
    const inject = optionalString(bridgeRecord, 'inject', `${at}bridge.`) ?? 'head-first'
    if (inject !== 'head-first') fail(`${at}bridge.inject`, `must be "head-first" -- got "${inject}"`)
    const file = bridgeRecord['file'] === undefined ? undefined : containedPath(bridgeRecord, 'file', `${at}bridge.`)
    const members = bridgeRecord['members'] === undefined ? undefined : containedPath(bridgeRecord, 'members', `${at}bridge.`)
    if (file === undefined && members === undefined) {
      fail(`${at}bridge`, 'needs "members" (a declaration the executor composes) or "file" (a script served as it is), or both')
    }
    bridge = {
      ...(file === undefined ? {} : { file }),
      ...(members === undefined ? {} : { members }),
      inject
    }
  }

  const extraValue = record['extraFiles']
  const extraFiles: ExtraFile[] = []
  if (extraValue !== undefined) {
    if (!Array.isArray(extraValue)) fail(`${at}extraFiles`, 'must be an array')
    extraValue.forEach((entry, index) => {
      const entryRecord = object(entry, `${at}extraFiles[${String(index)}]`, ['from', 'to'])
      extraFiles.push({
        from: containedPath(entryRecord, 'from', `${at}extraFiles[${String(index)}].`),
        to: containedPath(entryRecord, 'to', `${at}extraFiles[${String(index)}].`)
      })
    })
  }

  const install = optionalString(record, 'install', at)
  const hooks = record['hooks'] === undefined ? undefined : containedPath(record, 'hooks', at)
  const icon = record['icon'] === undefined ? undefined : containedPath(record, 'icon', at)
  if (icon !== undefined && ICON_TYPES[extensionOf(icon)] === undefined) {
    fail(`${at}icon`, `must be an image Orivon's favicon capture reads (${Object.keys(ICON_TYPES).join(', ')}), or the tab shows a globe -- "${icon}" is not one`)
  }

  return {
    ...common,
    upstream: {
      repo,
      ref,
      licence: string(upstreamRecord, 'licence', `${at}upstream.`),
      ...(tagPattern === undefined ? {} : { tagPattern }),
      ...(prerelease === undefined ? {} : { prerelease }),
      ...(library ? { library: true as const } : {})
    },
    ...(install === undefined ? {} : { install }),
    build: {
      command: string(buildRecord, 'command', `${at}build.`),
      output: buildOutput(buildRecord, `${at}build.`),
      ...(also === undefined ? {} : { also: also as readonly string[] })
    },
    ...(bridge === undefined ? {} : { bridge }),
    extraFiles,
    ...(hooks === undefined ? {} : { hooks }),
    ...(icon === undefined ? {} : { icon })
  }
}

/**
 * Recipe commands run in a directory whose absolute path depends on the
 * checkout, so they name directories by token instead. An unknown token throws
 * rather than reaching the shell: `rm -rf {oout}/x` expands to `rm -rf /x`
 * under a substitution that silently leaves unknowns alone. A directory is
 * quoted, because a checkout path can hold a space.
 */
export function expandTokens (command: string, dirs: RecipeDirs): string {
  return command.replace(/\{([a-zA-Z]+)\}/g, (_match, token: string) => {
    if (token === 'recipe' || token === 'source' || token === 'static') return shellQuote(dirs[token])
    throw new RecipeError(`unknown token {${token}} -- expected {recipe}, {source} or {static}`)
  })
}
