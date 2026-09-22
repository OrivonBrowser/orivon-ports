import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

// Step 0 and step 1 of the porting method, run for you. It answers one
// question -- how much of this app is already a web page -- and one that
// decides the cost: is the preload a list of named members, or a single
// generic forwarder? See docs/porting-guide.md for what to do with the answer.

const SOURCE_FILE = /\.(?:js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/
const SKIP_DIR = /^(?:node_modules|\.git|dist|build|out|coverage)$/

const NODE_BUILTIN = /require\(['"]node:|from\s+['"](?:node:)?(?:fs|path|os|net|dgram|crypto|stream|zlib|util|events|child_process|http|https)['"]/
const ELECTRON_IMPORT = /from\s+['"]electron['"]|require\(['"]electron['"]\)/
const FETCH_CALL = /\bfetch\s*\(/g
const EXPOSE = /exposeInMainWorld\s*\(\s*['"]([A-Za-z0-9_$]+)['"]/g
const IPC_HANDLER = /ipcMain\.(?:handle|handleOnce|on|once)\s*\(/g
// A channel passed as a VARIABLE rather than a string literal: the preload
// forwards whatever it is handed, so its member list says nothing about the
// real surface.
const GENERIC_FORWARDER = /ipcRenderer\.(?:invoke|send)\s*\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*[,)]/

export interface ReconReport {
  readonly roots: Readonly<Record<string, string | undefined>>
  readonly nodeBuiltins: readonly string[]
  readonly electronImports: readonly string[]
  readonly fetchCalls: number
  readonly bridgeNames: readonly string[]
  /** Every member the renderer calls, per exposed global. A preload may expose several. */
  readonly membersByGlobal: Readonly<Record<string, readonly string[]>>
  /** The union of the above, for the report's own count. */
  readonly members: readonly string[]
  readonly ipcHandlers: number
  readonly genericForwarder: boolean
}

async function walk (dir: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(entry.name)) found.push(...await walk(path))
    } else if (SOURCE_FILE.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

async function findDir (clone: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const entries = await readdir(join(clone, name)).catch(() => undefined)
    if (entries !== undefined) return join(clone, name)
  }
  return undefined
}

function countMatches (text: string, pattern: RegExp): number {
  return text.match(new RegExp(pattern.source, 'g'))?.length ?? 0
}

export async function recon (clone: string): Promise<ReconReport> {
  const renderer = await findDir(clone, ['src/renderer', 'src/render', 'src/ui', 'app/renderer', 'src'])
  const preload = await findDir(clone, ['src/preload', 'src/preload.js', 'app/preload', 'src'])
  const main = await findDir(clone, ['src/main', 'app/main', 'src'])

  const rendererFiles = renderer === undefined ? [] : await walk(renderer)
  const nodeBuiltins: string[] = []
  const electronImports: string[] = []
  let fetchCalls = 0

  for (const file of rendererFiles) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (NODE_BUILTIN.test(text)) nodeBuiltins.push(relative(clone, file))
    if (ELECTRON_IMPORT.test(text)) electronImports.push(relative(clone, file))
    fetchCalls += countMatches(text, FETCH_CALL)
  }

  const bridgeNames = new Set<string>()
  let genericForwarder = false
  for (const file of preload === undefined ? [] : await walk(preload)) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const match of text.matchAll(EXPOSE)) bridgeNames.add(match[1] as string)
    if (GENERIC_FORWARDER.test(text)) genericForwarder = true
  }

  // Cross-check the preload against what the renderer actually calls, one
  // list per exposed global. Neither source is provably complete -- computed
  // keys and Object.assign defeat both -- so this is a floor, never a total.
  const calls = [...bridgeNames].map((name) => ({ name, pattern: new RegExp(`window\\.${name}\\.([A-Za-z0-9_$]+)`, 'g'), found: new Set<string>() }))
  for (const file of rendererFiles) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const call of calls) {
      for (const match of text.matchAll(call.pattern)) call.found.add(match[1] as string)
    }
  }
  const membersByGlobal: Record<string, readonly string[]> = {}
  const members = new Set<string>()
  for (const call of calls) {
    membersByGlobal[call.name] = [...call.found].sort()
    for (const member of call.found) members.add(member)
  }

  let ipcHandlers = 0
  for (const file of main === undefined ? [] : await walk(main)) {
    ipcHandlers += countMatches(await readFile(file, 'utf8').catch(() => ''), IPC_HANDLER)
  }

  return {
    roots: {
      renderer: renderer === undefined ? undefined : relative(clone, renderer),
      preload: preload === undefined ? undefined : relative(clone, preload),
      main: main === undefined ? undefined : relative(clone, main)
    },
    nodeBuiltins,
    electronImports,
    fetchCalls,
    bridgeNames: [...bridgeNames].sort(),
    membersByGlobal,
    members: [...members].sort(),
    ipcHandlers,
    genericForwarder
  }
}

function sample (files: readonly string[]): string {
  if (files.length === 0) return 'none'
  return `${String(files.length)} (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', ...' : ''})`
}

export function formatRecon (report: ReconReport, clone: string): string {
  const lines = [
    `# Port recon: ${clone}`,
    '',
    '| Question | Answer |',
    '|---|---|',
    `| Renderer root | ${report.roots['renderer'] ?? 'NOT FOUND'} |`,
    `| Preload root | ${report.roots['preload'] ?? 'NOT FOUND'} |`,
    `| Main root | ${report.roots['main'] ?? 'NOT FOUND'} |`,
    `| Renderer files importing a node builtin | ${sample(report.nodeBuiltins)} |`,
    `| Renderer files importing \`electron\` | ${sample(report.electronImports)} |`,
    `| \`fetch(\` call sites in the renderer | ${String(report.fetchCalls)} |`,
    `| \`exposeInMainWorld\` bridge names | ${report.bridgeNames.join(', ') || 'none'} |`,
    `| Bridge members the renderer calls | ${String(report.members.length)} |`,
    `| \`ipcMain\` handlers in main | ${String(report.ipcHandlers)} |`,
    ''
  ]

  if (report.bridgeNames.length === 0) {
    lines.push('**No preload bridge found.** Either this app is not contextIsolated, or the preload',
      'lives somewhere this scan did not look. Point `--preload` at it before trusting the zero.', '')
  } else if (report.genericForwarder) {
    lines.push(`**Generic forwarder.** The preload passes channel names straight through, so the ${String(report.members.length)}`,
      `members above are not the real surface -- the ${String(report.ipcHandlers)} \`ipcMain\` handlers are. Budget against`,
      'that number, and expect the open-ended shape rather than the cheap one.', '')
  } else {
    lines.push(`**Named members.** ${String(report.members.length)} called members at roughly six lines each is the bridge`,
      `estimate. ${String(report.ipcHandlers)} \`ipcMain\` handlers is the ceiling if the count above is under-reading.`, '')
  }

  if (report.nodeBuiltins.length === 0 && report.electronImports.length === 0) {
    lines.push('**The renderer imports no node builtin and no `electron`.** Shim families 1 and 2 never',
      'reach it: the whole port is the bridge plus routed `fetch`.', '')
  }

  lines.push('Members the renderer calls:', '', ...report.members.map((member) => `- \`${member}\``), '',
    'This is a floor, not a total: computed keys and `Object.assign` defeat a static read.')
  return lines.join('\n')
}

/**
 * The member list, written out as a declaration with every name still
 * unbucketed. `parseDeclaration` then refuses the port until a person has
 * moved each one, which is the whole design: this automates the typing, never
 * the judgment. docs/porting-guide.md step 2 is the judgment.
 */
export function declarationFrom (report: ReconReport, only?: string): Record<string, unknown> {
  const names = only === undefined ? report.bridgeNames : [only]
  if (names.length === 0) {
    throw new Error('this clone exposed no preload bridge to name -- pass --global, or check the reported preload root')
  }
  for (const name of names) {
    if (report.membersByGlobal[name] === undefined) {
      throw new Error(`this clone exposes ${report.bridgeNames.join(', ') || 'no bridge'}, not "${name}"`)
    }
  }

  if (names.length === 1) {
    const name = names[0] as string
    return { global: name, hand: [], unclassified: report.membersByGlobal[name] }
  }
  const globals: Record<string, unknown> = {}
  for (const name of names) globals[name] = { hand: [], unclassified: report.membersByGlobal[name] }
  return { globals }
}

function bucketed (buckets: unknown): boolean {
  if (typeof buckets !== 'object' || buckets === null) return false
  const record = buckets as Record<string, unknown>
  const hand = record['hand']
  if (Array.isArray(hand) && hand.length > 0) return true
  return Object.keys(record).some((key) => key !== 'hand' && key !== 'unclassified' && key !== 'global')
}

/** The two declaration forms as one map of global -> its buckets, so a merge does not care which form either side used. */
function toGlobalMap (declaration: Record<string, unknown>): Record<string, unknown> {
  if (typeof declaration['global'] !== 'string') return (declaration['globals'] as Record<string, unknown> | undefined) ?? {}
  const { global: name, globals, ...buckets } = declaration
  void globals
  return { [name as string]: buckets }
}

/**
 * Writes the skeleton, merging into one that is already there rather than
 * replacing it: a fourteen-global app is bucketed a few globals at a time, and
 * a second pass must not undo the first. A global somebody has already
 * bucketed is left exactly as it is, and named in the return value.
 */
export async function writeDeclaration (path: string, report: ReconReport, only?: string): Promise<readonly string[]> {
  const fresh = toGlobalMap(declarationFrom(report, only))
  const existing = await readFile(path, 'utf8').catch(() => undefined)
  const current = existing === undefined ? {} : toGlobalMap(JSON.parse(existing) as Record<string, unknown>)

  const merged: Record<string, unknown> = {}
  const kept: string[] = []
  for (const [name, buckets] of Object.entries(current)) {
    if (bucketed(buckets)) { merged[name] = buckets; kept.push(name) }
  }
  for (const [name, buckets] of Object.entries(fresh)) {
    if (merged[name] === undefined) merged[name] = buckets
  }

  const names = Object.keys(merged)
  const out = names.length === 1
    ? { global: names[0], ...(merged[names[0] as string] as Record<string, unknown>) }
    : { globals: merged }
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`)
  return kept
}
