import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ELECTRON_TABLE, loadCompat, mvpCandidate, NATIVE_TABLE, NODE_TABLE, trimTo } from './compat-tables.ts'
import type { Compat, Index, Row, Status } from './compat-tables.ts'
import { formatRecon } from './recon.ts'
import type { ReconReport } from './recon.ts'
import { runsIn, scanClone } from './usage-scan.ts'
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
  /** `dropped` for a use found only in main or preload files: the port does not run that code, so it has no verdict. */
  readonly category: Category | 'dropped'
  /** False when every file that uses it is main or preload code, or when it is only declared. */
  readonly runs: boolean
  /** A package the manifest declares and no scanned file imports: judged, but not counted. */
  readonly declared: boolean
  /** Files that use it; 0 for a dependency declared in a manifest and never seen imported. */
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
  readonly scan: { readonly files: number; readonly testFilesSkipped: number; readonly computedSpawns: number }
  readonly verdicts: readonly Verdict[]
  /** Counts of the verdicts that run in Orivon only. */
  readonly counts: Readonly<Record<Category, number>>
  /** Uses found only in main or preload code. */
  readonly droppedCount: number
  /** Packages declared in a manifest and never seen imported. */
  readonly declaredCount: number
}

type Draft = Omit<Verdict, 'runs' | 'category' | 'declared'> & { readonly category: Category; readonly declared?: boolean }

const categoryOf = (status: Status): Category => status

/** The worst category among the rows, in the report's order. */
function worst (rows: readonly VerdictRow[]): Category {
  return CATEGORIES.find((category) => rows.some((row) => categoryOf(row.status) === category)) ?? 'unknown'
}

const toVerdictRow = ({ status, label, note, instead, table, line }: Row): VerdictRow => ({ status, label, note, instead, table, line })

/**
 * Among rows that differ by the argument they are about, the ones that apply to the calls seen: a
 * literal gets the row for that literal, else the generic row; a computed argument gets them all.
 */
function pick (rows: Row[], args: readonly (string | null)[] | undefined): Row[] {
  if (args === undefined || args.includes(null) || !rows.some((row) => row.argument !== undefined)) return rows
  const chosen = new Set<Row>()
  for (const arg of args) {
    const exact = rows.filter((row) => row.argument === arg)
    for (const row of exact.length > 0 ? exact : rows.filter((row) => row.argument === undefined)) chosen.add(row)
  }
  return chosen.size > 0 ? [...chosen] : rows
}

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

function base (use: Use): Pick<Draft, 'files' | 'first' | 'roles'> {
  return { files: use.files.length, first: use.first, roles: use.roles }
}

const unique = (files: readonly string[]): number => new Set(files).size

function judgeElectron (uses: readonly Use[], compat: Compat): Draft[] {
  const verdicts: Draft[] = []
  const inherited = new Map<string, { rows: VerdictRow[]; uses: Use[]; members: string[] }>()
  const direct = new Map(uses.map((use) => [use.api, use]))
  for (const use of uses) {
    const { rows, via, context } = electronRows(compat.electron, use.api)
    const own = (via === undefined ? pick(rows, use.args) : rows).map(toVerdictRow)
    if (via !== undefined) {
      const group = inherited.get(via) ?? { rows: own, uses: [], members: [] }
      group.uses.push(use)
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
    const sources = [...group.uses, ...direct.has(api) && !group.uses.includes(direct.get(api) as Use) ? [direct.get(api) as Use] : []]
    const files = [...new Set(sources.flatMap((use) => use.files))]
    const roles = [...new Set(sources.flatMap((use) => use.roles))].sort()
    const first = (sources.find((use) => runsIn(use.roles)) ?? sources[0])?.first ?? ''
    const members = [...new Set(group.members)]
    const extra = members.length > 0 ? `members used: ${members.slice(0, 10).join(', ')}${members.length > 10 ? `, +${String(members.length - 10)}` : ''}` : undefined
    const merged: Draft = { area: 'electron', api, category: worst(group.rows), files: files.length, first, roles, rows: group.rows, ...extra === undefined ? {} : { extra } }
    if (at === -1) verdicts.push(merged)
    else verdicts[at] = merged
  }
  return verdicts
}

function judgeNode (uses: readonly Use[], compat: Compat): Draft[] {
  const verdicts: Draft[] = []
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
    const real = entry.members.filter((member) => refused?.names.has(member) === true || isNodeMember(compat, module, member))
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

/**
 * Whether Node exports `member` from `module`: a local variable named `path` has no `charAt` to report.
 * orivon-mvp records Node's exports per module; without that file Node itself is asked, with its
 * warnings muted (loading `node:sqlite` prints one). True when neither can say.
 */
function isNodeMember (compat: Compat, module: string, member: string): boolean {
  const listed = compat.builtinExports.get(module)
  if (listed !== undefined) return listed.has(member)
  const emit = process.emitWarning
  process.emitWarning = (() => undefined) as typeof process.emitWarning
  try {
    const builtin = process.getBuiltinModule(`node:${module}`) as Record<string, unknown> | undefined
    return builtin === undefined || member in builtin
  } catch {
    return true
  } finally {
    process.emitWarning = emit
  }
}

/** `fs/promises.readFile` and `fs.readFile`: the member is the last dotted segment, the module everything before it. */
function splitNode (api: string): [string, string | undefined] {
  const dot = api.lastIndexOf('.')
  return dot === -1 ? [api, undefined] : [api.slice(0, dot), api.slice(dot + 1)]
}

function judgePackages (scan: UsageScan, compat: Compat): Draft[] {
  const verdicts: Draft[] = []
  for (const dependency of scan.dependencies) {
    const rows = packageRows(compat, dependency.name).map(toVerdictRow)
    const native = scan.nativeAddons.some((addon) => addon.name === dependency.name)
    if (rows.length === 0 && !native) continue
    const extra = rows.length === 0 ? `a native addon not in Orivon's tables: it needs a WebAssembly build (${GUIDE})` : undefined
    const seen = scan.imports.find((use) => use.api === dependency.name)
    const where = seen === undefined ? { files: 0, first: dependency.from, roles: [] as string[] } : base(seen)
    verdicts.push({ area: 'package', api: dependency.name, category: rows.length > 0 ? worst(rows) : 'unknown', ...where, rows, ...seen === undefined ? { declared: true } : {}, ...extra === undefined ? {} : { extra } })
  }
  return verdicts
}

function judgePrograms (scan: UsageScan): Draft[] {
  return scan.spawns.map((call) => {
    const fork = call.fn === 'fork'
    const note = fork
      ? `fork runs the app's own module from its served path in a Worker with the Node shim; synchronous fs and spawnSync need the manifest's crossOriginIsolated (${GUIDE})`
      : `a native binary refuses as ENOEXEC; \`${call.program}\` runs only as a wasm32-wasip1 build (files) or wasm32-wasip2 build (network) the port ships (${GUIDE})`
    const row: VerdictRow = { status: 'limits', label: `${call.fn}('${call.program}')`, note, instead: '', table: 'docs/porting-guide.md', line: 0 }
    return { area: 'program', api: `${call.fn}('${call.program}')`, category: 'limits', files: unique(call.files), first: call.files[0] ?? '', roles: call.roles, rows: [row] } satisfies Draft
  })
}

function count (verdicts: readonly Verdict[]): Record<Category, number> {
  const counts: Record<Category, number> = { missing: 0, excluded: 0, unknown: 0, limits: 0, works: 0 }
  for (const verdict of verdicts) if (verdict.runs && verdict.category !== 'dropped') counts[verdict.category]++
  return counts
}

/** Marks each draft as running, dropped or only declared; a dropped one keeps its rows as hints and loses its verdict. */
function place (drafts: readonly Draft[]): Verdict[] {
  return drafts.map(({ declared = false, ...draft }) => {
    if (declared) return { ...draft, runs: false, declared: true }
    return runsIn(draft.roles) ? { ...draft, runs: true, declared: false } : { ...draft, runs: false, declared: false, category: 'dropped' as const }
  })
}

/** The verdicts for a scan against the tables; with no tables, every use is listed without one. */
export function judge (scan: UsageScan, compat: Compat | undefined, mvp: Feasibility['mvp']): Feasibility {
  const info = { files: scan.files, testFilesSkipped: scan.testFilesSkipped, computedSpawns: scan.computedSpawns }
  let drafts: Draft[]
  if (compat === undefined) {
    const bare = (area: Draft['area'], uses: readonly Use[]): Draft[] => uses.map((use) => ({ area, api: use.api, category: 'unknown' as const, ...base(use), rows: [] }))
    drafts = [...bare('electron', scan.electron), ...bare('node', scan.node), ...judgePrograms(scan).map((v) => ({ ...v, category: 'unknown' as const }))]
  } else {
    drafts = [...judgeElectron(scan.electron, compat), ...judgeNode(scan.node, compat), ...judgePackages(scan, compat), ...judgePrograms(scan)]
  }
  const verdicts = place(drafts)
  return {
    mvp,
    warnings: compat?.warnings ?? [],
    scan: info,
    verdicts,
    counts: count(verdicts),
    droppedCount: verdicts.filter((verdict) => verdict.category === 'dropped').length,
    declaredCount: verdicts.filter((verdict) => verdict.declared).length
  }
}

/** Finds the tables, reads the app's source and judges the one against the other. */
export async function assess (clone: string, report: ReconReport, options: { mvp?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Feasibility> {
  const candidate = mvpCandidate(options.mvp, options.env)
  const found = [ELECTRON_TABLE, NODE_TABLE, NATIVE_TABLE].some((file) => existsSync(join(candidate.path, file)))
  const compat = found ? await loadCompat(candidate.path) : undefined
  const processKeys = new Set([...compat?.electron.keys() ?? []].filter((key) => key.startsWith('process.')))
  const scan = await scanClone(resolve(clone), report.roots, processKeys)
  return judge(scan, compat, { found, path: candidate.path, from: candidate.from })
}

const tableName = (path: string): string => path.split('/').pop() ?? path

function rowText (row: VerdictRow): string {
  const instead = row.instead === '' || row.instead === 'nothing' ? '' : ` Instead: ${trimTo(row.instead, 70)}`
  const where = row.line > 0 ? `${tableName(row.table)}:${String(row.line)}` : row.table === '' ? '' : tableName(row.table)
  return `${trimTo(row.note, 100)}${instead}${where === '' ? '' : ` [${where}]`}`
}

function line (verdict: Verdict): string[] {
  const where = verdict.declared
    ? `declared in ${verdict.first}`
    : `${String(verdict.files)} file${verdict.files === 1 ? '' : 's'}, first ${verdict.first}${verdict.roles.length > 0 ? ` (${verdict.roles.join('/')})` : ''}`
  const out = [`- \`${verdict.api}\` -- ${where}`]
  if (verdict.rows.length === 1) out.push(`  ${rowText(verdict.rows[0] as VerdictRow)}`)
  else for (const row of verdict.rows) out.push(`  - ${row.label}: ${rowText(row)}`)
  if (verdict.extra !== undefined) out.push(`  ${verdict.extra}`)
  return out
}

/** The recon report as `formatRecon` writes it, followed by the "What Orivon can run" section. */
export function formatFullRecon (report: ReconReport, clone: string, feasibility: Feasibility, suggestions = ''): string {
  return `${formatRecon(report, clone)}\n${suggestions === '' ? '' : `${suggestions}\n`}${formatFeasibility(feasibility)}`
}

const DROPPED_LEAD = 'In an Electron port main and preload never run; the bridge re-creates only what the renderer calls (the members list above), so these lines say what a bridge member would use, not what Orivon lacks.'

function hint (row: VerdictRow): string {
  const useInstead = row.instead !== '' && row.instead !== 'nothing'
  const text = useInstead ? row.instead : row.note
  const where = row.line > 0 ? `${tableName(row.table)}:${String(row.line)}` : row.table === '' ? '' : tableName(row.table)
  return `${useInstead ? 'instead: ' : ''}${trimTo(text, 120)}${where === '' ? '' : ` [${where}]`}`
}

function hintLines (verdict: Verdict): string[] {
  const where = `${String(verdict.files)} file${verdict.files === 1 ? '' : 's'}, first ${verdict.first} (${verdict.roles.join('/')})`
  const out = [`- \`${verdict.api}\` -- ${where}`]
  if (verdict.rows.length === 1) out.push(`  ${hint(verdict.rows[0] as VerdictRow)}`)
  else for (const row of verdict.rows) out.push(`  - ${row.label}: ${hint(row)}`)
  if (verdict.rows.length === 0) out.push('  no row in the tables')
  return out
}

const byName = (a: Verdict, b: Verdict): number => a.area.localeCompare(b.area) || a.api.localeCompare(b.api)

/** The "What Orivon can run" section of a recon report. */
export function formatFeasibility (feasibility: Feasibility): string {
  const { mvp, counts, verdicts, scan, droppedCount, declaredCount } = feasibility
  const running = verdicts.filter((verdict) => verdict.runs)
  const dropped = verdicts.filter((verdict) => verdict.category === 'dropped').sort(byName)
  const declared = verdicts.filter((verdict) => verdict.declared).sort(byName)
  const out = ['', '## What Orivon can run', '']
  if (!mvp.found) {
    out.push(`**No orivon-mvp checkout was found**, so nothing below has a verdict. Looked at \`${mvp.path}\` (${mvp.from}).`,
      'Point `ORIVON_MVP_ROOT` at a checkout of orivon-mvp, or pass `--mvp <path>`, and run recon again: the verdicts are read from its',
      'compatibility tables at run time, never kept in this repository.', '')
  } else {
    out.push(`Verdicts are read from orivon-mvp's compatibility tables at \`${mvp.path}\` (${mvp.from}); each line names the table and row it came from.`, '')
    for (const warning of feasibility.warnings) out.push(`**Warning:** ${warning}`, '')
  }
  const more = (droppedCount > 0 ? ` ${String(droppedCount)} more sit only in main or preload, which the port drops.` : '') +
    (declaredCount > 0 ? ` ${String(declaredCount)} declared ${declaredCount === 1 ? 'package was' : 'packages were'} never seen imported.` : '')
  if (verdicts.length === 0) {
    out.push(`Nothing to judge: no Electron API, Node module, program or listed package was found in ${String(scan.files)} files.`)
  } else if (mvp.found) {
    const parts = CATEGORIES.map((category) => `${String(counts[category])} ${({ missing: 'missing', excluded: 'excluded', unknown: 'not in the tables', limits: 'with limits', works: 'work' })[category]}`)
    out.push(`${String(running.length)} ${running.length === 1 ? 'use' : 'uses'} in code that runs in Orivon: ${parts.join(', ')}.${more}`)
  } else {
    out.push(`${String(running.length)} ${running.length === 1 ? 'use' : 'uses'} in code that runs in Orivon (no verdicts).${more}`)
  }
  out.push('',
    `Static reading is a floor, never a total: computed keys, dynamic requires and a dependency's own code are not read` +
      `${scan.computedSpawns > 0 ? `; ${String(scan.computedSpawns)} process start(s) take a computed program, not listed here` : ''}. Scanned ${String(scan.files)} files of the clone${scan.testFilesSkipped > 0 ? ` (${String(scan.testFilesSkipped)} test, mock, tooling, declaration and build-output files left out)` : ''}.`, '')

  if (!mvp.found) {
    for (const verdict of running.sort(byName)) out.push(...line(verdict))
  } else {
    for (const category of CATEGORIES) {
      const group = running.filter((verdict) => verdict.category === category).sort(byName)
      if (group.length === 0) continue
      out.push(`### ${HEADINGS[category]} (${String(group.length)})`, '', MEANING[category], '')
      for (const verdict of group) out.push(...line(verdict))
      out.push('')
    }
  }
  if (declared.length > 0) {
    out.push(`### Declared in package.json, never seen imported (${String(declared.length)})`, '',
      'No scanned file imports these, so they may be used by code the scan cannot see, or not at all. Each line shows the verdict it would get; none is counted above.', '')
    for (const verdict of declared) {
      const [first, ...rest] = line(verdict)
      out.push(`${first as string} (would be: ${HEADINGS[verdict.category as Category]})`, ...rest)
    }
    out.push('')
  }
  if (dropped.length > 0) {
    out.push(`### Main and preload: dropped, the bridge stands in (${String(dropped.length)})`, '', DROPPED_LEAD, '')
    for (const verdict of dropped) out.push(...hintLines(verdict))
  }
  return out.join('\n').trimEnd()
}
