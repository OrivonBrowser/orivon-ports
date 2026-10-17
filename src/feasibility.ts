import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ELECTRON_TABLE, loadCompat, mvpCandidate, NATIVE_TABLE, NODE_TABLE, trimTo } from './compat-tables.ts'
import type { Compat, Index, Row, Status } from './compat-tables.ts'
import { formatRecon } from './recon.ts'
import type { ReconReport } from './recon.ts'
import { scanClone } from './usage-scan.ts'
import type { UsageScan, Use } from './usage-scan.ts'

// Joins what an app uses (usage-scan.ts) to what Orivon's own tables say
// (compat-tables.ts), and writes it for a porter: a person or a model.

export type Category = 'missing' | 'excluded' | 'unknown' | 'limits' | 'works'

/** The order the report lists them in: what stops a port first. */
export const CATEGORIES: readonly Category[] = ['missing', 'excluded', 'unknown', 'limits', 'works']

const HEADINGS: Readonly<Record<Category, string>> = {
  missing: 'Missing in Orivon',
  excluded: 'Excluded by Orivon',
  unknown: "Not in Orivon's tables",
  limits: 'Works with limits',
  works: 'Works today'
}

const MEANING: Readonly<Record<Category, string>> = {
  missing: 'Orivon lacks it. If the app needs it, stop and hand orivon-mvp a prompt (CLAUDE.md Rule 9); a note that names a substitute is port work.',
  excluded: 'Orivon excludes it by decision. The port refuses it by name and never works around it.',
  unknown: 'No row in the compatibility tables: check by hand.',
  limits: 'It works with limits: read the note.',
  works: 'It works in Orivon today.'
}

const GUIDE = 'docs/porting-guide.md section Native addons, child processes and daemons'

export interface VerdictRow {
  readonly status: Status
  readonly label: string
  readonly note: string
  readonly instead: string
  readonly table: string
  readonly line: number
}

export interface Verdict {
  readonly area: 'electron' | 'node' | 'package' | 'program'
  readonly api: string
  readonly category: Category
  /** Files that use it; 0 for a dependency declared in a manifest. */
  readonly files: number
  readonly first: string
  readonly roles: readonly string[]
  readonly rows: readonly VerdictRow[]
  /** Said when no row decides, or to add what the rows do not know. */
  readonly extra?: string
}

export interface Feasibility {
  readonly mvp: { readonly found: boolean; readonly path: string; readonly from: string }
  readonly warnings: readonly string[]
  readonly scan: { readonly dirs: readonly string[]; readonly files: number; readonly testFilesSkipped: number; readonly computedSpawns: number; readonly hostSideOnly: number }
  readonly verdicts: readonly Verdict[]
  readonly counts: Readonly<Record<Category, number>>
}

const categoryOf = (status: Status): Category => status

/** The worst category among the rows, in the report's order. */
function worst (rows: readonly VerdictRow[]): Category {
  return CATEGORIES.find((category) => rows.some((row) => categoryOf(row.status) === category)) ?? 'unknown'
}

const toVerdictRow = ({ status, label, note, instead, table, line }: Row): VerdictRow => ({ status, label, note, instead, table, line })

const capitalised = (name: string): string => `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`

/**
 * The rows for an Electron name: its own; else those the table keeps under the
 * class the path reaches (`session.defaultSession.cookies.set` is `Cookies.set`);
 * else those of the export above it that excludes or lacks everything beneath,
 * which `via` names.
 */
function electronRows (index: Index, path: string): { rows: Row[]; via?: string; context?: Row } {
  const own = index.get(path) ?? (path === 'remote' || path.startsWith('remote.') ? index.get(`electron.${path}`) : undefined)
  if (own !== undefined) return { rows: own }
  const parts = path.split('.').filter((part) => part !== 'defaultSession')
  for (let i = parts.length - 2; i >= 0; i--) {
    const aliased = index.get([capitalised(parts[i] as string), ...parts.slice(i + 1)].join('.'))
    if (aliased !== undefined) return { rows: aliased }
  }
  const above = path.split('.')
  while (above.length > 1) {
    above.pop()
    const key = above.join('.')
    const exported = (index.get(key) ?? []).filter((row) => row.exportLevel)
    const decisive = exported.filter((row) => row.status === 'missing' || row.status === 'excluded')
    if (decisive.length > 0) return { rows: decisive, via: key }
    if (exported[0] !== undefined) return { rows: [], context: exported[0] }
  }
  return { rows: [] }
}

function nodeRows (compat: Compat, module: string): Row[] {
  return compat.nodeModules.get(module) ?? compat.nodeModules.get(`node:${module}`) ?? []
}

function packageRows (compat: Compat, name: string): Row[] {
  const rows = [...compat.nativePackages.get(name) ?? [], ...compat.electronPackages.get(name) ?? []]
  for (const glob of compat.nativeGlobs) if (name.startsWith(glob.prefix)) rows.push(...glob.rows)
  return rows
}

function base (use: Use): Pick<Verdict, 'files' | 'first' | 'roles'> {
  return { files: use.files.length, first: use.files[0] ?? '', roles: use.roles }
}

const unique = (files: readonly string[]): number => new Set(files).size

function judgeElectron (uses: readonly Use[], compat: Compat): Verdict[] {
  const verdicts: Verdict[] = []
  const inherited = new Map<string, { rows: VerdictRow[]; files: string[]; roles: Set<string>; members: string[] }>()
  const direct = new Map(uses.map((use) => [use.api, use]))
  for (const use of uses) {
    const { rows, via, context } = electronRows(compat.electron, use.api)
    const own = rows.map(toVerdictRow)
    if (via !== undefined) {
      const group = inherited.get(via) ?? { rows: own, files: [], roles: new Set<string>(), members: [] }
      group.files.push(...use.files)
      for (const role of use.roles) group.roles.add(role)
      if (use.api !== via) group.members.push(use.api.slice(via.length + 1))
      inherited.set(via, group)
      continue
    }
    const category = own.length > 0 ? worst(own) : 'unknown'
    const covered = !use.api.includes('.') && uses.some((other) => other.api.startsWith(`${use.api}.`))
    if (covered && category !== 'missing' && category !== 'excluded') continue
    const typeLike = own.length === 0 && context === undefined && /^[A-Z]/.test(use.api) && !use.api.includes('.')
    const extra = context !== undefined
      ? `no row for this member; its export row says ${context.status}: ${trimTo(context.note, 100)}`
      : typeLike ? 'no row; a TypeScript type imported by name needs none' : undefined
    verdicts.push({ area: 'electron', api: use.api, category, ...base(use), rows: own, ...extra === undefined ? {} : { extra } })
  }
  for (const [api, group] of inherited) {
    const at = verdicts.findIndex((verdict) => verdict.api === api)
    const files = [...new Set([...group.files, ...direct.get(api)?.files ?? []])].sort()
    const roles = [...new Set([...group.roles, ...direct.get(api)?.roles ?? []])].sort()
    const members = [...new Set(group.members)]
    const extra = members.length > 0 ? `members used: ${members.slice(0, 10).join(', ')}${members.length > 10 ? `, +${String(members.length - 10)}` : ''}` : undefined
    const merged: Verdict = { area: 'electron', api, category: worst(group.rows), files: files.length, first: files[0] ?? '', roles, rows: group.rows, ...extra === undefined ? {} : { extra } }
    if (at === -1) verdicts.push(merged)
    else verdicts[at] = merged
  }
  return verdicts
}

function judgeNode (uses: readonly Use[], compat: Compat): Verdict[] {
  const verdicts: Verdict[] = []
  const modules = new Map<string, { use: Use | undefined; members: string[] }>()
  for (const use of uses) {
    const [module, member] = splitNode(use.api)
    const entry = modules.get(module) ?? { use: undefined, members: [] }
    if (member === undefined) entry.use = use
    else entry.members.push(member)
    modules.set(module, entry)
  }
  for (const [module, entry] of modules) {
    const refused = compat.refusals.get(module)
    const own = nodeRows(compat, module).map(toVerdictRow)
    const some = entry.use ?? uses.find((use) => use.api.startsWith(`${module}.`)) as Use
    const real = entry.members.filter((member) => refused?.names.has(member) === true || isNodeMember(module, member))
    entry.members = real
    const used = real.filter((member) => refused?.names.has(member) !== true)
    const listing = used.length > 0 ? `members used: ${used.slice(0, 12).join(', ')}${used.length > 12 ? `, +${String(used.length - 12)}` : ''}` : undefined
    const note = refused === undefined && entry.members.length > 0 ? 'no member-level data for this module: read its row' : undefined
    const extra = [listing, note].filter((text): text is string => text !== undefined).join('; ')
    verdicts.push({ area: 'node', api: module, category: own.length > 0 ? worst(own) : 'unknown', ...base(some), rows: own, ...extra === '' ? {} : { extra } })
    for (const member of entry.members.filter((name) => refused?.names.has(name) === true)) {
      const hit = uses.find((use) => use.api === `${module}.${member}`) as Use
      const moduleRow = own[0]
      const row: VerdictRow = {
        status: 'missing',
        label: `${module}.${member}`,
        note: `the shim refuses \`${module}.${member}\` by name (${refused?.file ?? 'generated list'}). The module row: ${moduleRow === undefined ? 'none' : trimTo(moduleRow.note, 90)}`,
        instead: '',
        table: moduleRow?.table ?? refused?.file ?? '',
        line: moduleRow?.line ?? 0
      }
      verdicts.push({ area: 'node', api: `${module}.${member}`, category: 'missing', ...base(hit), rows: [row] })
    }
  }
  return verdicts
}

/** Whether Node itself exports `member` from `module`: a local variable named `path` has no `charAt` to report. True when Node cannot say. */
function isNodeMember (module: string, member: string): boolean {
  try {
    const builtin = process.getBuiltinModule(`node:${module}`) as Record<string, unknown> | undefined
    return builtin === undefined || member in builtin
  } catch {
    return true
  }
}

/** `fs/promises.readFile` and `fs.readFile`: the member is the last dotted segment, the module everything before it. */
function splitNode (api: string): [string, string | undefined] {
  const dot = api.lastIndexOf('.')
  return dot === -1 ? [api, undefined] : [api.slice(0, dot), api.slice(dot + 1)]
}

function judgePackages (scan: UsageScan, compat: Compat): Verdict[] {
  const verdicts: Verdict[] = []
  for (const dependency of scan.dependencies) {
    const rows = packageRows(compat, dependency.name).map(toVerdictRow)
    const native = scan.nativeAddons.some((addon) => addon.name === dependency.name)
    if (rows.length === 0 && !native) continue
    const extra = rows.length === 0 ? `a native addon not in Orivon's tables: it needs a WebAssembly build (${GUIDE})` : undefined
    verdicts.push({ area: 'package', api: dependency.name, category: rows.length > 0 ? worst(rows) : 'unknown', files: 0, first: dependency.from, roles: [], rows, ...extra === undefined ? {} : { extra } })
  }
  return verdicts
}

function judgePrograms (scan: UsageScan): Verdict[] {
  return scan.spawns.map((call) => {
    const fork = call.fn === 'fork'
    const note = fork
      ? `fork runs the app's own module from its served path in a Worker with the Node shim; synchronous fs and spawnSync need the manifest's crossOriginIsolated (${GUIDE})`
      : `a native binary refuses as ENOEXEC; \`${call.program}\` runs only as a wasm32-wasip1 build (files) or wasm32-wasip2 build (network) the port ships (${GUIDE})`
    const row: VerdictRow = { status: 'limits', label: `${call.fn}('${call.program}')`, note, instead: '', table: 'docs/porting-guide.md', line: 0 }
    return { area: 'program', api: `${call.fn}('${call.program}')`, category: 'limits', files: unique(call.files), first: call.files[0] ?? '', roles: [], rows: [row] } satisfies Verdict
  })
}

function count (verdicts: readonly Verdict[]): Record<Category, number> {
  const counts: Record<Category, number> = { missing: 0, excluded: 0, unknown: 0, limits: 0, works: 0 }
  for (const verdict of verdicts) counts[verdict.category]++
  return counts
}

/** The verdicts for a scan against the tables; with no tables, every use is listed without one. */
export function judge (scan: UsageScan, compat: Compat | undefined, mvp: Feasibility['mvp']): Feasibility {
  const dirs = scan.scanned
  const info = { dirs, files: scan.files, testFilesSkipped: scan.testFilesSkipped, computedSpawns: scan.computedSpawns, hostSideOnly: 0 }
  if (compat === undefined) {
    const bare = (area: Verdict['area'], uses: readonly Use[]): Verdict[] => uses.map((use) => ({ area, api: use.api, category: 'unknown' as const, ...base(use), files: unique(use.files), rows: [] }))
    const verdicts = [...bare('electron', scan.electron), ...bare('node', scan.node), ...judgePrograms(scan).map((v) => ({ ...v, category: 'unknown' as const }))]
    return { mvp, warnings: [], scan: info, verdicts, counts: count(verdicts) }
  }
  const verdicts = [...judgeElectron(scan.electron, compat), ...judgeNode(scan.node, compat), ...judgePackages(scan, compat), ...judgePrograms(scan)]
  const hostSideOnly = verdicts.filter((verdict) => verdict.roles.length > 0 && verdict.roles.every((role) => role === 'main' || role === 'preload')).length
  return { mvp, warnings: compat.warnings, scan: { ...info, hostSideOnly }, verdicts, counts: count(verdicts) }
}

/** Finds the tables, reads the app's source and judges the one against the other. */
export async function assess (clone: string, report: ReconReport, options: { mvp?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Feasibility> {
  const candidate = mvpCandidate(options.mvp, options.env)
  const found = [ELECTRON_TABLE, NODE_TABLE, NATIVE_TABLE].some((file) => existsSync(join(candidate.path, file)))
  const compat = found ? await loadCompat(candidate.path) : undefined
  const processKeys = new Set([...compat?.electron.keys() ?? []].filter((key) => key.startsWith('process.')))
  const scan = await scanClone(clone, report.roots, processKeys)
  return judge(scan, compat, { found, path: candidate.path, from: candidate.from })
}

const tableName = (path: string): string => path.split('/').pop() ?? path

function rowText (row: VerdictRow): string {
  const instead = row.instead === '' || row.instead === 'nothing' ? '' : ` Instead: ${trimTo(row.instead, 70)}`
  const where = row.line > 0 ? `${tableName(row.table)}:${String(row.line)}` : row.table === '' ? '' : tableName(row.table)
  return `${trimTo(row.note, 100)}${instead}${where === '' ? '' : ` [${where}]`}`
}

function line (verdict: Verdict): string[] {
  const where = verdict.area === 'package'
    ? `declared in ${verdict.first}`
    : `${String(verdict.files)} file${verdict.files === 1 ? '' : 's'}, first ${verdict.first}${verdict.roles.length > 0 ? ` (${verdict.roles.join('/')})` : ''}`
  const out = [`- \`${verdict.api}\` -- ${where}`]
  if (verdict.rows.length === 1) out.push(`  ${rowText(verdict.rows[0] as VerdictRow)}`)
  else for (const row of verdict.rows) out.push(`  - ${row.label}: ${rowText(row)}`)
  if (verdict.extra !== undefined) out.push(`  ${verdict.extra}`)
  return out
}

/** The recon report as `formatRecon` writes it, followed by the "What Orivon can run" section. */
export function formatFullRecon (report: ReconReport, clone: string, feasibility: Feasibility): string {
  return `${formatRecon(report, clone)}\n${formatFeasibility(feasibility)}`
}

/** The "What Orivon can run" section of a recon report. */
export function formatFeasibility (feasibility: Feasibility): string {
  const { mvp, counts, verdicts, scan } = feasibility
  const out = ['', '## What Orivon can run', '']
  if (!mvp.found) {
    out.push(`**No orivon-mvp checkout was found**, so nothing below has a verdict. Looked at \`${mvp.path}\` (${mvp.from}).`,
      'Point `ORIVON_MVP_ROOT` at a checkout of orivon-mvp, or pass `--mvp <path>`, and run recon again: the verdicts are read from its',
      'compatibility tables at run time, never kept in this repository.', '')
  } else {
    out.push(`Verdicts are read from orivon-mvp's compatibility tables at \`${mvp.path}\` (${mvp.from}); each line names the table and row it came from.`, '')
    for (const warning of feasibility.warnings) out.push(`**Warning:** ${warning}`, '')
  }
  const total = verdicts.length
  if (total === 0) {
    out.push(`Nothing to judge: no Electron API, Node module, program or listed package was found in ${String(scan.files)} files.`)
  } else if (mvp.found) {
    const parts = CATEGORIES.map((category) => `${String(counts[category])} ${({ missing: 'missing', excluded: 'excluded', unknown: 'not in the tables', limits: 'with limits', works: 'work' })[category]}`)
    out.push(`${String(total)} APIs, modules, packages and programs used: ${parts.join(', ')}.`)
  } else {
    out.push(`${String(total)} Electron APIs, Node modules and programs used (no verdicts).`)
  }
  out.push('',
    'Where a use sits decides what it costs: in a contextIsolated app main and preload are dropped, so their Electron and Node use becomes bridge',
    `work, while code that runs in the renderer (a nodeIntegration app's own \`electron\` imports among it) meets these verdicts directly.${scan.hostSideOnly > 0 ? ` ${String(scan.hostSideOnly)} of the ${String(total)} uses sit only in main or preload code.` : ''}`,
    `Static reading is a floor, never a total: computed keys, dynamic requires and a dependency's own code are not read` +
      `${scan.computedSpawns > 0 ? `; ${String(scan.computedSpawns)} process start(s) take a computed program, not listed here` : ''}. Scanned ${String(scan.files)} files under ${scan.dirs.join(', ')}${scan.testFilesSkipped > 0 ? ` (${String(scan.testFilesSkipped)} test, mock and declaration files left out)` : ''}.`, '')

  if (!mvp.found) {
    for (const verdict of verdicts) out.push(...line(verdict))
    return out.join('\n')
  }
  for (const category of CATEGORIES) {
    const group = verdicts.filter((verdict) => verdict.category === category)
    if (group.length === 0) continue
    out.push(`### ${HEADINGS[category]} (${String(group.length)})`, '', MEANING[category], '')
    for (const verdict of group.sort((a, b) => a.area.localeCompare(b.area) || a.api.localeCompare(b.api))) out.push(...line(verdict))
    out.push('')
  }
  return out.join('\n').trimEnd()
}
