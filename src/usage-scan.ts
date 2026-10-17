import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inClone, walk } from './recon.ts'
import { scanSource } from './source-ast.ts'
import type { FileUses } from './source-ast.ts'

// What an app's own source asks of Orivon: the Electron exports and members it
// touches, the Node modules and members, the programs it starts, and the
// packages it depends on. The whole clone is read; the roots recon found only
// decide which role a file has. A static read, so a floor and never a total.

export interface Use {
  /** `app.getPath`, `fs`, `fs.readFile`, `@electron/remote`: the name a table row is looked up by. */
  readonly api: string
  /** The scanned files that use it, relative to the clone. */
  readonly files: readonly string[]
  /** Where those files sit: `main`, `preload`, `renderer`, or the directory when the roots are not told apart. */
  readonly roles: readonly string[]
  /** The file to name first: one in a role that runs in Orivon when there is one. */
  readonly first: string
  /** For an Electron member: the first argument of each call that has one, a string literal or null when computed. */
  readonly args?: readonly (string | null)[]
}

/** Roles whose code a port drops: an Electron app's main process and its preload. */
export const HOST_ROLES: ReadonlySet<string> = new Set(['main', 'preload'])
export const runsIn = (roles: readonly string[]): boolean => roles.length === 0 || roles.some((role) => !HOST_ROLES.has(role))

export interface SpawnUse { readonly fn: string; readonly program: string; readonly files: readonly string[]; readonly roles: readonly string[] }

export interface Dependency { readonly name: string; readonly from: string }

export interface UsageScan {
  readonly files: number
  /** Tests, mocks, tooling, type declarations and build output: not the app's source, so not read. */
  readonly testFilesSkipped: number
  readonly electron: readonly Use[]
  readonly node: readonly Use[]
  readonly spawns: readonly SpawnUse[]
  /** The npm packages the scanned files import, by package name, with where. */
  readonly imports: readonly Use[]
  /** Calls to a spawning function whose first argument is not a string literal. */
  readonly computedSpawns: number
  readonly dependencies: readonly Dependency[]
  readonly nativeAddons: readonly Dependency[]
  /** A scanned package.json lists `electron`, or a file imports `electron` or `@electron/remote`. */
  readonly electronApp: boolean
}

const MAX_SOURCE_BYTES = 1_000_000
// Not the app's own source: tests and mocks, type declarations, and the tooling that builds or tests it
// (`*.config.*`, `scripts/`, `hak/`, `playwright/`, `electron-builder.*`), none of which runs in Orivon.
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.config\.[^/]*$|\.d\.ts$|(?:^|\/)electron-builder\.[^/]*$|(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|cypress|playwright|_?scripts|tools|hak)\//
// Build output and caches that recon's walk does not know: hidden directories, `dist-*`, `bundles`, bundles and minified files.
const BUILD_OUTPUT = /(?:^|\/)\.[^/]+\/|(?:^|\/)(?:dist|build|out)-[^/]+\/|(?:^|\/)bundles\/|\.(?:bundle|chunk|min)\.[cm]?js$/

/** A name that marks a file as preload or main code in an Electron app: narrow, so `views/main/Home.js` stays a view. */
function roleByName (file: string): string | undefined {
  const parts = file.split('/')
  const name = parts.pop() ?? ''
  if (/^preload\./i.test(name) || /\.preload\./i.test(name) || parts.some((dir) => /preload(?:er)?$/i.test(dir))) return 'preload'
  if (/^electron-main\./.test(name) || parts.some((dir, i) => dir === 'electron' || dir === 'electron-main' || (dir === 'main' && parts[i - 1] === 'src'))) return 'main'
  return undefined
}

/**
 * The role of a file, by the first rule that applies: (a) it sits under a root recon named `main`,
 * `preload` or `renderer`; (b) in an Electron app, its imports say so (a main-process export of
 * `electron` is main, `contextBridge` preload); (c) in an Electron app, a narrow directory or file
 * name; (d) the longest root holding it, which recon sets to `src` for all three when it found none
 * of its own, else `clone`.
 */
export function roleOf (file: string, roots: Readonly<Record<string, string | undefined>>, electronApp: boolean, hostRole: FileUses['hostRole']): string {
  let named: { role: string; length: number } | undefined
  let generic: string | undefined
  for (const [role, root] of Object.entries(roots)) {
    if (root === undefined || !(file === root || file.startsWith(`${root}/`))) continue
    if ((root.split('/').pop() ?? root) === role) {
      if (named === undefined || root.length > named.length) named = { role, length: root.length }
    } else if (generic === undefined || root.length > generic.length) {
      generic = root
    }
  }
  if (named !== undefined) return named.role
  if (electronApp) {
    const role = hostRole ?? roleByName(file)
    if (role !== undefined) return role
  }
  return generic ?? 'clone'
}

async function readJson (path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Whether `path` is `clone` or below it, whatever the separator. */
const inside = (clone: string, path: string): boolean => {
  const rel = relative(clone, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function packages (clone: string, dirs: readonly string[]): Promise<{ dependencies: Dependency[]; nativeAddons: Dependency[]; electronDependency: boolean }> {
  const manifests = new Set<string>([clone])
  for (const dir of dirs) {
    for (let current = resolve(clone, dir); inside(clone, current) && current !== dirname(current); current = dirname(current)) {
      manifests.add(current)
      if (current === clone) break
    }
  }
  const dependencies: Dependency[] = []
  const nativeAddons: Dependency[] = []
  const seen = new Set<string>()
  let electronDependency = false
  for (const dir of manifests) {
    const manifest = await readJson(join(dir, 'package.json'))
    if (manifest === undefined) continue
    const from = relative(clone, join(dir, 'package.json')).split(sep).join('/')
    for (const field of ['dependencies', 'devDependencies']) {
      const list = manifest[field]
      if (typeof list === 'object' && list !== null && 'electron' in list) electronDependency = true
    }
    for (const field of ['dependencies', 'optionalDependencies']) {
      const list = manifest[field]
      if (typeof list !== 'object' || list === null) continue
      for (const name of Object.keys(list)) {
        if (seen.has(name)) continue
        seen.add(name)
        dependencies.push({ name, from })
        const installed = [join(dir, 'node_modules', name), join(clone, 'node_modules', name)].find((path) => existsSync(path))
        if (installed === undefined) continue
        const own = await readJson(join(installed, 'package.json'))
        if (existsSync(join(installed, 'binding.gyp')) || own?.['gypfile'] === true || (own !== undefined && 'napi' in own)) nativeAddons.push({ name, from })
      }
    }
  }
  return { dependencies, nativeAddons, electronDependency }
}

interface Entry { files: string[]; roles: Set<string>; running: string | undefined; args: Set<string | null> }

/**
 * Scans every source file of the clone (skipping `node_modules`, builds, tests, tooling config and
 * anything over a megabyte). `roots` are the directories recon found; they only name roles.
 */
export async function scanClone (cloneDir: string, roots: Readonly<Record<string, string | undefined>>, processKeys: ReadonlySet<string> = new Set()): Promise<UsageScan> {
  const clone = resolve(cloneDir)
  const rootDirs = [...new Set(Object.values(roots).filter((root): root is string => root !== undefined))]
  const manifest = await packages(clone, rootDirs)
  const dependencyNames = new Set(manifest.dependencies.map((dependency) => dependency.name))
  const files = (await walk(clone)).map((file) => inClone(clone, file)).sort()

  let testFilesSkipped = 0
  const read: { file: string; uses: FileUses }[] = []
  for (const file of files) {
    if (TEST_FILE.test(file) || BUILD_OUTPUT.test(file)) { testFilesSkipped++; continue }
    const size = (await stat(join(clone, file)).catch(() => undefined))?.size ?? 0
    if (size > MAX_SOURCE_BYTES) continue
    const source = await readFile(join(clone, file), 'utf8').catch(() => '')
    read.push({ file, uses: scanSource(source, { processKeys, packages: dependencyNames, file }) })
  }
  const electronApp = manifest.electronDependency || read.some(({ uses }) => uses.importsElectron)

  const electron = new Map<string, Entry>()
  const node = new Map<string, Entry>()
  const imported = new Map<string, Entry>()
  const spawns = new Map<string, { fn: string; program: string; files: string[]; roles: Set<string> }>()
  let computedSpawns = 0
  const note = (map: Map<string, Entry>, api: string, file: string, role: string, args?: ReadonlySet<string | null>): void => {
    const entry = map.get(api) ?? { files: [], roles: new Set<string>(), running: undefined, args: new Set<string | null>() }
    entry.files.push(file)
    entry.roles.add(role)
    if (entry.running === undefined && !HOST_ROLES.has(role)) entry.running = file
    for (const arg of args ?? []) entry.args.add(arg)
    map.set(api, entry)
  }

  for (const { file, uses } of read) {
    const role = roleOf(file, roots, electronApp, uses.hostRole)
    for (const api of uses.electron) note(electron, api, file, role, uses.electronArgs.get(api))
    for (const api of uses.node) note(node, api, file, role)
    for (const api of uses.imports) note(imported, api, file, role)
    for (const call of uses.spawns) {
      if (call.program === undefined) { computedSpawns++; continue }
      const key = `${call.fn}\0${call.program}`
      const entry = spawns.get(key) ?? { fn: call.fn, program: call.program, files: [], roles: new Set<string>() }
      entry.files.push(file)
      entry.roles.add(role)
      spawns.set(key, entry)
    }
  }

  const toUses = (map: Map<string, Entry>): Use[] =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([api, entry]) => ({
      api,
      files: entry.files,
      roles: [...entry.roles].sort(),
      first: entry.running ?? entry.files[0] ?? '',
      ...entry.args.size > 0 ? { args: [...entry.args] } : {}
    }))
  return {
    files: read.length,
    testFilesSkipped,
    electron: toUses(electron),
    node: toUses(node),
    spawns: [...spawns.values()].sort((a, b) => a.program.localeCompare(b.program)).map((call) => ({ ...call, roles: [...call.roles].sort() })),
    imports: toUses(imported),
    computedSpawns,
    dependencies: manifest.dependencies,
    nativeAddons: manifest.nativeAddons,
    electronApp
  }
}
