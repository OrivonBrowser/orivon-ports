// A recipe is the one file a person writes by hand to add a port, so every
// rejection here names the field that is wrong. "Invalid recipe" with no field
// name is what makes a newcomer give up; see README.md's Design notes.

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

export interface ExtraFile {
  readonly from: string
  readonly to: string
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
}

/** Somebody else's app: cloned at a pinned commit and built by its own toolchain. */
export interface PortRecipe extends RecipeCommon {
  readonly upstream: UpstreamSpec
  readonly install?: string
  readonly build: BuildSpec
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

export interface RecipeDirs {
  readonly recipe: string
  readonly source: string
  readonly static: string
}

const ID = /^[a-z0-9][a-z0-9-]*$/
const FULL_SHA = /^[0-9a-f]{40}$/
const ETH_NAME = /^[a-z0-9][a-z0-9-]*\.eth$/
const MIN_UNPRIVILEGED_PORT = 1024
const MAX_PORT = 65535

const TOP_LEVEL_KEYS = ['id', 'name', 'port', 'upstream', 'install', 'build', 'manifest', 'entry', 'bridge', 'extraFiles', 'hooks', 'eth', 'site']
// A site is served as it is written, so every field that fetches, builds or
// patches something has nothing to act on beside it.
const PORT_ONLY_KEYS = ['upstream', 'install', 'build', 'bridge', 'extraFiles', 'hooks']
const UPSTREAM_KEYS = ['repo', 'ref', 'licence']
const BUILD_KEYS = ['command', 'output', 'also']
const BRIDGE_KEYS = ['file', 'members', 'inject']

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
    fail(`${at}eth`, `must be one lowercase label followed by ".eth" -- "${eth}" is not, e.g. "freetube.eth"`)
  }

  const common = {
    id,
    name: string(record, 'name', at),
    port,
    manifest: containedPath(record, 'manifest', at),
    entry: optionalString(record, 'entry', at) ?? 'index.html',
    ...(eth === undefined ? {} : { eth })
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

  return {
    ...common,
    upstream: { repo, ref, licence: string(upstreamRecord, 'licence', `${at}upstream.`) },
    ...(install === undefined ? {} : { install }),
    build: {
      command: string(buildRecord, 'command', `${at}build.`),
      output: containedPath(buildRecord, 'output', `${at}build.`),
      ...(also === undefined ? {} : { also: also as readonly string[] })
    },
    ...(bridge === undefined ? {} : { bridge }),
    extraFiles,
    ...(hooks === undefined ? {} : { hooks })
  }
}

/**
 * Recipe commands run in a directory whose absolute path depends on the
 * checkout, so they name directories by token instead. An unknown token throws
 * rather than reaching the shell: `rm -rf {oout}/x` expands to `rm -rf /x`
 * under a substitution that silently leaves unknowns alone.
 */
export function expandTokens (command: string, dirs: RecipeDirs): string {
  return command.replace(/\{([a-zA-Z]+)\}/g, (_match, token: string) => {
    if (token === 'recipe' || token === 'source' || token === 'static') return dirs[token]
    throw new RecipeError(`unknown token {${token}} -- expected {recipe}, {source} or {static}`)
  })
}
