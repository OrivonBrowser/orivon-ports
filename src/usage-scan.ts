import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { inClone, walk } from './recon.ts'

// What an app's own source asks of Orivon: the Electron exports and members it
// touches, the Node modules and members, the programs it starts, and the
// packages it depends on. A static read, so a floor and never a total:
// computed keys, dynamic requires and the dependencies' own code are invisible.

export interface Use {
  /** `app.getPath`, `fs`, `fs.readFile`, `@electron/remote`: the name a table row is looked up by. */
  readonly api: string
  /** The scanned files that use it, relative to the clone. */
  readonly files: readonly string[]
  /** Where those files sit: `main`, `preload`, `renderer`, or the directory when the roots are not told apart. */
  readonly roles: readonly string[]
}

export interface SpawnUse { readonly fn: string; readonly program: string; readonly files: readonly string[] }

export interface Dependency { readonly name: string; readonly from: string }

export interface UsageScan {
  readonly scanned: readonly string[]
  readonly files: number
  /** Test files, mocks and type declarations: not the app, so not read. */
  readonly testFilesSkipped: number
  readonly electron: readonly Use[]
  readonly node: readonly Use[]
  readonly spawns: readonly SpawnUse[]
  /** Calls to a spawning function whose first argument is not a string literal. */
  readonly computedSpawns: number
  readonly dependencies: readonly Dependency[]
  readonly nativeAddons: readonly Dependency[]
}

export interface FileUses {
  readonly electron: ReadonlySet<string>
  readonly node: ReadonlySet<string>
  readonly spawns: readonly { readonly fn: string; readonly program: string | undefined }[]
}

interface Binding { readonly local: string; readonly module: string; readonly member: string | undefined }

const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'])
const MAX_SOURCE_BYTES = 1_000_000
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$|(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|cypress)\//
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

/** `node:fs` and `fs` are `fs`; a name that is not a Node module is undefined. */
export function nodeModuleName (specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return specifier.slice(5)
  return NODE_BUILTINS.has(specifier) && !specifier.startsWith('_') ? specifier : undefined
}

function electronSpecifier (specifier: string): string | undefined {
  if (specifier === 'electron' || /^electron\/(?:main|renderer|common|utility)$/.test(specifier)) return specifier
  if (specifier === '@electron/remote' || specifier.startsWith('@electron/remote/') || specifier === 'original-fs') return specifier
  return undefined
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function members (list: string): { name: string; local: string }[] {
  const items: { name: string; local: string }[] = []
  for (const raw of list.split(',')) {
    const item = raw.replace(/=.*$/s, '').trim()
    if (item === '' || /^type\s/.test(item) || item.includes('{')) continue
    const [name, local] = item.split(/\s+as\s+|\s*:\s*/)
    if (name !== undefined && /^[\w$]+$/.test(name)) items.push({ name, local: local?.trim() ?? name })
  }
  return items
}

function bindingsOf (text: string): { bindings: Binding[]; modules: Set<string>; chains: { module: string; path: string }[] } {
  const bindings: Binding[] = []
  const modules = new Set<string>()
  const chains: { module: string; path: string }[] = []

  for (const match of text.matchAll(/\bimport\s+(?!type\b)([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = match[1] as string
    const module = match[2] as string
    modules.add(module)
    const named = /\{([^}]*)\}/.exec(clause)?.[1]
    const rest = clause.replace(/\{[^}]*\}/, '')
    const star = /\*\s*as\s+([\w$]+)/.exec(rest)?.[1]
    const def = /^[\s,]*([\w$]+)/.exec(rest.replace(/\*\s*as\s+[\w$]+/, ''))?.[1]
    if (star !== undefined) bindings.push({ local: star, module, member: undefined })
    if (def !== undefined) bindings.push({ local: def, module, member: undefined })
    for (const { name, local } of members(named ?? '')) bindings.push({ local, module, member: name })
  }
  for (const match of text.matchAll(/\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]|\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*['"]([^'"]+)['"]/g)) {
    modules.add((match[1] ?? match[2]) as string)
  }
  for (const match of text.matchAll(/\bimport\s+([\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    modules.add(match[2] as string)
    bindings.push({ local: match[1] as string, module: match[2] as string, member: undefined })
  }
  const required = /\b(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*(?:await\s+)?(?:(?:window|global|globalThis)\.)?require\(\s*['"]([^'"]+)['"]\s*\)(?:\??\.([\w$]+))?/g
  for (const match of text.matchAll(required)) {
    const target = match[1] as string
    const module = match[2] as string
    const member = match[3]
    if (target.startsWith('{')) {
      for (const { name, local } of members(target.slice(1, -1))) bindings.push({ local, module, member: name })
    } else {
      bindings.push({ local: target, module, member })
    }
  }
  for (const match of text.matchAll(/(?:\b(?:window|global|globalThis)\.)?\brequire\(\s*['"]([^'"]+)['"]\s*\)((?:\??\.[\w$]+){0,3})/g)) {
    const module = match[1] as string
    modules.add(module)
    const path = (match[2] ?? '').replace(/\?/g, '').replace(/^\./, '')
    if (path !== '') chains.push({ module, path })
  }
  return { bindings, modules, chains }
}

/** `L.a.b.c` read off a bound local: the member path, at most three deep. */
function pathsOff (text: string, local: string): string[] {
  const pattern = new RegExp(`(?<![\\w$.])${escapeRe(local)}((?:\\??\\.[\\w$]+){1,3})`, 'g')
  return [...text.matchAll(pattern)].map((match) => (match[1] as string).replace(/\?/g, '').slice(1))
}

const firstArgument = /^\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/

function spawnCalls (text: string, bindings: readonly Binding[], chains: readonly { module: string; path: string }[]): { fn: string; program: string | undefined }[] {
  const calls: { fn: string; program: string | undefined }[] = []
  const argument = (from: number, fn: string): void => {
    const literal = firstArgument.exec(text.slice(from, from + 600))
    if (literal === null) { calls.push({ fn, program: undefined }); return }
    const value = literal[2] as string
    if (literal[1] === '`' && value.includes('${')) { calls.push({ fn, program: undefined }); return }
    calls.push({ fn, program: fn.startsWith('exec') && !fn.startsWith('execFile') ? (value.trim().split(/\s+/)[0] ?? '') : value })
  }
  for (const binding of bindings.filter((b) => b.module === 'child_process' || b.module === 'node:child_process')) {
    const name = escapeRe(binding.local)
    if (binding.member === undefined) {
      for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${name}\\??\\.(${[...SPAWNERS].join('|')})\\s*\\(`, 'g'))) {
        argument((match.index as number) + match[0].length, match[1] as string)
      }
    } else if (SPAWNERS.has(binding.member)) {
      for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g'))) {
        if (!new RegExp(`(?:function|const|let|var)\\s+${name}\\s*$`).test(text.slice(Math.max(0, (match.index as number) - 20), match.index))) {
          argument((match.index as number) + match[0].length, binding.member)
        }
      }
    }
  }
  for (const { module, path } of chains) {
    if (module.replace(/^node:/, '') === 'child_process' && SPAWNERS.has(path.split('.')[0] as string)) {
      for (const match of text.matchAll(new RegExp(`require\\(\\s*['"](?:node:)?child_process['"]\\s*\\)\\.${escapeRe(path.split('.')[0] as string)}\\s*\\(`, 'g'))) {
        argument((match.index as number) + match[0].length, path.split('.')[0] as string)
      }
    }
  }
  return calls
}

/** `fs.promises.readFile` is the `readFile` of `fs/promises`. */
function nodeMember (module: string, path: string): { module: string; member: string } {
  const [first, second] = path.split('.')
  if (first === 'promises' && second !== undefined && ['fs', 'dns', 'stream', 'timers', 'readline'].includes(module)) return { module: `${module}/promises`, member: second }
  return { module, member: first as string }
}

/**
 * What one file's source uses. `processKeys` are the `process.*` names the
 * Electron table has rows for; with none given, `process` is not read.
 */
export function scanSource (source: string, options: { processKeys?: ReadonlySet<string>; packages?: ReadonlySet<string> } = {}): FileUses {
  const processKeys = options.processKeys ?? new Set<string>()
  const packages = options.packages ?? new Set<string>()
  // A bare `buffer` that the app lists as a dependency is that package, not Node's.
  const nodeModule = (specifier: string): string | undefined => specifier.startsWith('node:') || !packages.has(specifier) ? nodeModuleName(specifier) : undefined
  const text = source.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n')
  const { bindings, modules, chains } = bindingsOf(text)
  const electron = new Set<string>()
  const node = new Set<string>()

  for (const specifier of modules) {
    const spec = electronSpecifier(specifier)
    if (spec !== undefined && spec !== 'electron') electron.add(spec.startsWith('@electron/remote') ? '@electron/remote' : spec)
    const name = nodeModule(specifier)
    if (name !== undefined) node.add(name)
  }
  for (const { module, path } of chains) {
    if (electronSpecifier(module) === undefined && nodeModule(module) === undefined) continue
    if (electronSpecifier(module) !== undefined) {
      if (electronSpecifier(module)?.startsWith('electron') === true) electron.add(path)
    } else {
      const name = nodeModule(module) as string
      const found = nodeMember(name, path)
      node.add(`${found.module}.${found.member}`)
    }
  }
  for (const binding of bindings) {
    const spec = electronSpecifier(binding.module)
    const name = nodeModule(binding.module)
    if (spec !== undefined && spec.startsWith('electron')) {
      if (binding.member === undefined) {
        for (const path of pathsOff(text, binding.local)) electron.add(path)
      } else {
        electron.add(binding.member)
        for (const path of pathsOff(text, binding.local)) electron.add(`${binding.member}.${path}`)
      }
    } else if (name !== undefined) {
      if (binding.member === undefined) {
        for (const path of pathsOff(text, binding.local)) {
          const found = nodeMember(name, path)
          node.add(`${found.module}.${found.member}`)
        }
      } else {
        node.add(`${name}.${binding.member}`)
      }
    }
  }
  if (processKeys.size > 0) {
    for (const path of pathsOff(text, 'process')) {
      const parts = path.split('.')
      const hit = [parts.slice(0, 2), parts.slice(0, 1)].map((p) => `process.${p.join('.')}`).find((key) => processKeys.has(key))
      if (hit !== undefined) electron.add(hit)
    }
  }
  return { electron, node, spawns: spawnCalls(text, bindings, chains) }
}

/** `main`, `preload` or `renderer` when the file sits under a root named so; otherwise the longest root holding it (recon falls back to `src` for all three), or `clone`. */
function roleOf (file: string, roots: Readonly<Record<string, string | undefined>>): string {
  let named: { role: string; length: number } | undefined
  let generic: string | undefined
  for (const [role, root] of Object.entries(roots)) {
    if (root === undefined || !(file === root || file.startsWith(`${root}/`))) continue
    if (basename(root) === role) {
      if (named === undefined || root.length > named.length) named = { role, length: root.length }
    } else if (generic === undefined || root.length > generic.length) {
      generic = root
    }
  }
  return named?.role ?? generic ?? 'clone'
}

const basename = (path: string): string => path.split('/').pop() ?? path

async function readJson (path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

async function packages (clone: string, dirs: readonly string[]): Promise<{ dependencies: Dependency[]; nativeAddons: Dependency[] }> {
  const manifests = new Set<string>([clone])
  for (const dir of dirs) {
    for (let current = join(clone, dir); current.startsWith(clone) && current !== dirname(current); current = dirname(current)) {
      manifests.add(current)
      if (current === clone) break
    }
  }
  const dependencies: Dependency[] = []
  const nativeAddons: Dependency[] = []
  const seen = new Set<string>()
  for (const dir of manifests) {
    const manifest = await readJson(join(dir, 'package.json'))
    if (manifest === undefined) continue
    const from = relative(clone, join(dir, 'package.json')).split(sep).join('/')
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
  return { dependencies, nativeAddons }
}

/**
 * Scans the app's own source under the roots recon found (or the whole clone
 * when it found none), skipping `node_modules`, builds and anything over a megabyte.
 */
export async function scanClone (clone: string, roots: Readonly<Record<string, string | undefined>>, processKeys: ReadonlySet<string> = new Set()): Promise<UsageScan> {
  const dirs = [...new Set(Object.values(roots).filter((root): root is string => root !== undefined))]
  const scanDirs = dirs.length === 0 ? [''] : dirs
  const manifest = await packages(clone, scanDirs)
  const dependencyNames = new Set(manifest.dependencies.map((dependency) => dependency.name))
  const files = new Set<string>()
  for (const dir of scanDirs) for (const file of await walk(join(clone, dir))) files.add(inClone(clone, file))

  const electron = new Map<string, { files: string[]; roles: Set<string> }>()
  const node = new Map<string, { files: string[]; roles: Set<string> }>()
  const spawns = new Map<string, { fn: string; program: string; files: string[] }>()
  let computedSpawns = 0
  const note = (map: Map<string, { files: string[]; roles: Set<string> }>, api: string, file: string, role: string): void => {
    const entry = map.get(api) ?? { files: [], roles: new Set<string>() }
    entry.files.push(file)
    entry.roles.add(role)
    map.set(api, entry)
  }

  let scanned = 0
  let testFilesSkipped = 0
  for (const file of [...files].sort()) {
    if (TEST_FILE.test(file)) { testFilesSkipped++; continue }
    const size = (await stat(join(clone, file)).catch(() => undefined))?.size ?? 0
    if (size > MAX_SOURCE_BYTES) continue
    const source = await readFile(join(clone, file), 'utf8').catch(() => '')
    scanned++
    const uses = scanSource(source, { processKeys, packages: dependencyNames })
    const role = roleOf(file, roots)
    for (const api of uses.electron) note(electron, api, file, role)
    for (const api of uses.node) note(node, api, file, role)
    for (const call of uses.spawns) {
      if (call.program === undefined) { computedSpawns++; continue }
      const key = `${call.fn}\0${call.program}`
      const entry = spawns.get(key) ?? { fn: call.fn, program: call.program, files: [] }
      entry.files.push(file)
      spawns.set(key, entry)
    }
  }

  const toUses = (map: Map<string, { files: string[]; roles: Set<string> }>): Use[] =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([api, entry]) => ({ api, files: entry.files, roles: [...entry.roles].sort() }))
  return {
    scanned: scanDirs.map((dir) => dir === '' ? '.' : dir),
    files: scanned,
    testFilesSkipped,
    electron: toUses(electron),
    node: toUses(node),
    spawns: [...spawns.values()].sort((a, b) => a.program.localeCompare(b.program)),
    computedSpawns,
    ...manifest
  }
}
