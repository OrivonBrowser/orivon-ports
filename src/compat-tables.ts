import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { REPO_ROOT } from './paths.ts'

// Orivon's own compatibility tables, read as files at run time. Nothing here
// imports from orivon-mvp and nothing is copied from it: src/README.md, Design
// notes, says why.

export type Status = 'works' | 'limits' | 'excluded' | 'missing'

/** One table row that says something about a name. */
export interface Row {
  readonly status: Status
  /** The row's own words about the status, markdown stripped. */
  readonly note: string
  /** What the row says a port uses instead, or the renderer answer, when the table has such a column. */
  readonly instead: string
  /** The first cell, trimmed: what the row is about. */
  readonly label: string
  /** The table's file name, relative to the mvp root. */
  readonly table: string
  readonly line: number
  /** The row is the export's own (a bold name), so every member below it inherits a missing or excluded verdict. */
  readonly exportLevel: boolean
}

export type Index = Map<string, Row[]>

export interface TableStats {
  readonly rows: number
  /** Rows whose status could not be read, or whose cell count is not the header's. */
  readonly skipped: number
  /** Rows that name nothing a use can be matched on (a row about events alone). */
  readonly unplaced: number
  readonly names: number
  readonly statuses: readonly Status[]
}

export interface Refusals {
  readonly module: string
  readonly file: string
  readonly names: ReadonlySet<string>
}

export interface Compat {
  readonly root: string
  readonly electron: Index
  readonly electronPackages: Index
  readonly nodeModules: Index
  readonly nativePackages: Index
  /** Trailing-`/*` names of table 5 (`@noble/*`), matched by prefix. */
  readonly nativeGlobs: readonly { readonly prefix: string; readonly rows: readonly Row[] }[]
  readonly refusals: ReadonlyMap<string, Refusals>
  readonly stats: Readonly<Record<'electron' | 'electronPackages' | 'nodeModules' | 'nativePackages', TableStats>> & { readonly refusalModules: number }
  /** What could not be read, in words: a missing file, a table that parsed to nothing. */
  readonly warnings: readonly string[]
}

export const TABLE_DIR = 'docs/planning/compatibility'
export const ELECTRON_TABLE = `${TABLE_DIR}/table-2b-electron.md`
export const NODE_TABLE = `${TABLE_DIR}/table-2a-node-modules.md`
export const NATIVE_TABLE = `${TABLE_DIR}/table-5-native-modules.md`
export const MVP_ENV = 'ORIVON_MVP_ROOT'

const STATUS_BY_MARK: Readonly<Record<string, Status>> = { '✅': 'works', '⚠': 'limits', '🚫': 'excluded', '❌': 'missing' }

/** The status a cell opens with, or undefined (a ➖ "not applicable" row, or a cell with no mark). */
export function statusOf (cell: string): Status | undefined {
  const first = [...cell.trim()][0]
  return first === undefined ? undefined : STATUS_BY_MARK[first]
}

/** Cells of a Markdown table row. A `|` inside a code span or after a backslash is not a separator. */
export function splitRow (line: string): string[] | undefined {
  const text = line.trim()
  if (!text.startsWith('|')) return undefined
  const cells: string[] = []
  let current = ''
  let inCode = false
  for (let i = 1; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === '\\' && text[i + 1] === '|') { current += '|'; i++; continue }
    if (ch === '`') inCode = !inCode
    if (ch === '|' && !inCode) { cells.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (current.trim() !== '') cells.push(current.trim())
  return cells
}

/** A cell's prose without the status mark, links reduced to their text, emphasis dropped, one line. */
export function plain (cell: string): string {
  return cell
    .replace(/^[\p{Extended_Pictographic}️➖\s]+/u, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** At most `max` characters, cut at a word. */
export function trimTo (text: string, max = 160): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}...`
}

interface Code {
  readonly text: string
  readonly bold: boolean
  /** Parenthesis nesting: a name inside "(...)" is prose about the row, not what it names. */
  readonly depth: number
  /** A top-level colon came before it, anywhere earlier in the cell. */
  readonly afterColon: boolean
  /** The ";"-separated part of the cell it sits in. */
  readonly clause: number
  /** It follows the word "event" in its clause: an event name, never a member read off an object. */
  readonly event: boolean
  /** The prose between the previous code span and this one. */
  readonly gap: string
}

/** The code spans of a cell, and the clauses that hold a top-level colon. */
function scanCell (cell: string): { spans: Code[]; colonClauses: Set<number> } {
  const spans: Code[] = []
  const colonClauses = new Set<number>()
  let depth = 0
  let afterColon = false
  let clause = 0
  let event = false
  let gap = ''
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i] as string
    if (ch === '`') {
      const end = cell.indexOf('`', i + 1)
      if (end === -1) break
      if (/\bevents?\b/.test(gap) && depth === 0) event = true
      const bold = cell.slice(i - 2, i) === '**' && cell.slice(end + 1, end + 3) === '**'
      spans.push({ text: cell.slice(i + 1, end), bold, depth, afterColon, clause, event, gap })
      gap = ''
      i = end
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth > 0) continue
    else if (ch === ':') { afterColon = true; colonClauses.add(clause) }
    else if (ch === ';') { clause++; event = false }
    gap += ch
  }
  return { spans, colonClauses }
}

export function codeSpans (cell: string): Code[] {
  return scanCell(cell).spans
}

const LEADING_PATH = /^<?[A-Za-z_$@][\w$@./*:-]*>?/

/** `app.getPath('userData')` is `app.getPath`: the name a use is matched on. */
export function pathOf (code: string): string | undefined {
  return LEADING_PATH.exec(code.trim())?.[0].replace(/\.$/, '')
}

interface Named { readonly key: string; readonly exportLevel: boolean }

/** The names an Electron table row is about. Rules are in the unit tests, one per row shape. */
export function electronKeys (cell: string): Named[] {
  const scanned = scanCell(cell)
  const spans = scanned.spans.filter((span) => span.depth === 0)
  const named: Named[] = []
  const add = (key: string | undefined, exportLevel = false): void => {
    if (key !== undefined && key !== '') named.push({ key, exportLevel })
  }
  const pathsOf = (list: readonly Code[]): string[] => list.map((span) => pathOf(span.text)).filter((p): p is string => p !== undefined)

  // A bold name is the export's own row; names after its colon are its members.
  const bold = spans.filter((span) => span.bold)
  if (bold.length > 0) {
    const objects = pathsOf(bold)
    for (const object of objects) add(object, true)
    for (const member of pathsOf(spans.filter((span) => span.afterColon && !span.bold && !span.event))) {
      for (const object of objects) add(joinPath(object, member))
    }
    return named
  }

  let objects: string[] | undefined
  for (let clause = 0; clause <= Math.max(0, ...spans.map((span) => span.clause)); clause++) {
    const inClause = spans.filter((span) => span.clause === clause)
    const names = inClause.filter((span) => !span.event)
    if (scanned.colonClauses.has(clause)) {
      // "`a` and `b` ...: `x`, `y`": the names before the colon are the objects, those after it their members.
      objects = pathsOf(names.filter((span) => !span.afterColon))
      const members = pathsOf(names.filter((span) => span.afterColon))
      for (const object of objects) {
        if (members.length === 0 && inClause.length === names.length) add(object)
        for (const member of members) add(joinPath(object, member))
      }
    } else if (objects !== undefined) {
      for (const member of pathsOf(names)) for (const object of objects) add(joinPath(object, member))
    } else {
      generic(names, inClause.length === names.length)
    }
  }
  return named

  // No colon: dotted names stand alone and undotted ones after them inherit the object; "`a` and `b`" and module
  // specifiers are objects of their own; otherwise the first is the object and the rest are its members.
  function generic (names: readonly Code[], whole: boolean): void {
    const paths = names.map((span) => ({ path: pathOf(span.text), gap: span.gap }))
    if (paths.length === 1 && whole) { add(paths[0]?.path); return }
    const dotted = paths.some((p) => p.path?.includes('.') === true && !p.path.startsWith('<'))
    const andJoined = paths.length > 1 && paths.every((p, i) => i === 0 || /^\s*and\s*$/.test(p.gap))
    let object: string | undefined
    for (const [i, { path }] of paths.entries()) {
      if (path === undefined) continue
      if (path.includes('.') && !path.startsWith('<')) {
        add(path)
        object = path.slice(0, path.lastIndexOf('.'))
      } else if (andJoined || /[/-]/.test(path) && !path.startsWith('<')) {
        add(path)
      } else if (i === 0 || object === undefined) {
        if (dotted) add(path)
        object = path
      } else {
        add(joinPath(object, path))
      }
    }
  }
}

function joinPath (object: string | undefined, member: string | undefined): string | undefined {
  if (object === undefined || member === undefined) return undefined
  return member.startsWith(`${object}.`) ? member : `${object}.${member}`
}

interface Parsed { readonly rows: string[][]; readonly lines: number[]; readonly skipped: number }

/** Every data row of every table whose header's first cell is `first`, optionally only inside the section opened by a heading matching `section`. */
export function tableRows (text: string, first: string, section?: RegExp): Parsed {
  const rows: string[][] = []
  const lines: number[] = []
  let skipped = 0
  let inSection = section === undefined
  let width = 0
  let inTable = false
  for (const [index, line] of text.split('\n').entries()) {
    if (/^#{1,6}\s/.test(line)) {
      if (section !== undefined) inSection = section.test(line)
      inTable = false
      continue
    }
    if (!inSection) continue
    const cells = splitRow(line)
    if (cells === undefined) { inTable = false; continue }
    if (cells[0] === first) { inTable = true; width = cells.length; continue }
    if (!inTable || /^:?-{3,}/.test(cells[0] ?? '')) continue
    if (cells.length !== width) { skipped++; continue }
    rows.push(cells)
    lines.push(index + 1)
  }
  return { rows, lines, skipped }
}

interface TableSpec {
  readonly first: string
  readonly section?: RegExp
  readonly statusCol: number
  readonly noteCol: number
  readonly insteadCol: number
  readonly names: (cells: readonly string[]) => Named[]
}

const namesInFirstCell = (cells: readonly string[]): Named[] =>
  codeSpans(cells[0] ?? '').map((span) => pathOf(span.text)).filter((n): n is string => n !== undefined).map((key) => ({ key, exportLevel: false }))

function parseTable (text: string, table: string, spec: TableSpec): { index: Index; stats: TableStats } {
  const parsed = tableRows(text, spec.first, spec.section)
  const index: Index = new Map()
  const statuses = new Set<Status>()
  let accepted = 0
  let unplaced = 0
  for (const [i, cells] of parsed.rows.entries()) {
    const status = statusOf(cells[spec.statusCol] ?? '')
    const named = spec.names(cells)
    if (status !== undefined && named.length === 0) unplaced++
    if (status === undefined || named.length === 0) continue
    accepted++
    statuses.add(status)
    const row = { status, note: plain(cells[spec.noteCol] ?? ''), instead: plain(cells[spec.insteadCol] ?? ''), label: trimTo(plain(cells[0] ?? ''), 100), table, line: parsed.lines[i] as number }
    for (const { key, exportLevel } of named) {
      const list = index.get(key) ?? []
      list.push({ ...row, exportLevel })
      index.set(key, list)
    }
  }
  const notApplicable = parsed.rows.filter((cells) => (cells[spec.statusCol] ?? '').trim().startsWith('➖')).length
  const skipped = parsed.rows.length - accepted - notApplicable - unplaced + parsed.skipped
  return { index, stats: { rows: accepted, skipped, unplaced, names: index.size, statuses: [...statuses] } }
}

/** Table 2b: one row per Electron export or group of members. A "not applicable" row is not an API and is left out. */
export const parseElectronTable = (text: string, table: string): { index: Index; stats: TableStats } =>
  parseTable(text, table, { first: 'Electron API', section: /^##\s+Table 2b\b/, statusCol: 2, noteCol: 2, insteadCol: 1, names: (cells) => electronKeys(cells[0] ?? '') })

/** Table 2c: one row per package that wraps Electron. */
export const parseElectronPackages = (text: string, table: string): { index: Index; stats: TableStats } =>
  parseTable(text, table, { first: 'Package', section: /^##\s+Table 2c\b/, statusCol: 2, noteCol: 2, insteadCol: 1, names: namesInFirstCell })

/** Table 2a: one row per Node module (several names to a row are possible). */
export const parseNodeModules = (text: string, table: string): { index: Index; stats: TableStats } =>
  parseTable(text, table, { first: 'Module', statusCol: 1, noteCol: 3, insteadCol: -1, names: namesInFirstCell })

/** Table 5, every section of it: npm package names, some as a trailing-`/*` group. */
export function parseNativeModules (text: string, table: string): { index: Index; globs: { prefix: string; rows: Row[] }[]; stats: TableStats } {
  const parsed = parseTable(text, table, { first: 'Library', statusCol: 3, noteCol: 3, insteadCol: 2, names: namesInFirstCell })
  const globs: { prefix: string; rows: Row[] }[] = []
  for (const key of [...parsed.index.keys()]) {
    if (!key.endsWith('/*')) continue
    globs.push({ prefix: key.slice(0, -1), rows: parsed.index.get(key) ?? [] })
    parsed.index.delete(key)
  }
  return { ...parsed, globs }
}

/** The members a generated refusal file names, and the Node module they belong to. */
export function parseRefusals (text: string, file: string): Refusals | undefined {
  const module = /a named export per Node `([^`]+)` member/.exec(text)?.[1]
  if (module === undefined) return undefined
  const names = new Set([...text.matchAll(/export const ([A-Za-z_$][\w$]*) = refusingExport\(/g)].map((m) => m[1] as string))
  return { module, file, names }
}

/** Every `*.ts` file directly inside a directory named `generated`, anywhere below `dir`. */
async function generatedFiles (dir: string, inGenerated = false): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await generatedFiles(path, entry.name === 'generated'))
    else if (inGenerated && entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

/** Where the orivon-mvp checkout is: `--mvp`, else `ORIVON_MVP_ROOT`, else the sibling of this repository. */
export function mvpCandidate (flagValue?: string, env: NodeJS.ProcessEnv = process.env): { path: string; from: string } {
  if (flagValue !== undefined) return { path: resolve(flagValue), from: '--mvp' }
  const fromEnv = env[MVP_ENV]
  if (fromEnv !== undefined && fromEnv !== '') return { path: resolve(fromEnv), from: MVP_ENV }
  return { path: resolve(REPO_ROOT, '..', 'orivon-mvp'), from: 'the sibling checkout of this repository' }
}

const read = (root: string, file: string): Promise<string | undefined> => readFile(join(root, file), 'utf8').catch(() => undefined)

/** Reads the tables under `root`. A file that is absent or parses to nothing becomes a warning, never a throw. */
export async function loadCompat (root: string): Promise<Compat> {
  const warnings: string[] = []
  const empty = (): TableStats => ({ rows: 0, skipped: 0, unplaced: 0, names: 0, statuses: [] })
  const blank = { index: new Map() as Index, stats: empty() }
  const take = async <T extends { index: Index; stats: TableStats }>(label: string, file: string, parse: (text: string, table: string) => T, fallback: T): Promise<T> => {
    const text = await read(root, file)
    if (text === undefined) {
      if (!warnings.some((warning) => warning.startsWith(`${file} not found`))) warnings.push(`${file} not found under ${root}`)
      return fallback
    }
    const parsed = parse(text, file)
    if (parsed.stats.rows === 0) warnings.push(`${label} (${file}): no rows could be read -- its shape may have changed`)
    if (parsed.stats.skipped > 0) warnings.push(`${label} (${file}): ${String(parsed.stats.skipped)} row(s) skipped as malformed`)
    return parsed
  }
  const electron = await take('table 2b', ELECTRON_TABLE, parseElectronTable, blank)
  const wrappers = await take('table 2c', ELECTRON_TABLE, parseElectronPackages, blank)
  const node = await take('table 2a', NODE_TABLE, parseNodeModules, blank)
  const native = await take('table 5', NATIVE_TABLE, parseNativeModules, { ...blank, globs: [] })

  const refusals = new Map<string, Refusals>()
  for (const path of await generatedFiles(join(root, 'src', 'shim'))) {
    const parsed = parseRefusals(await readFile(path, 'utf8').catch(() => ''), relative(root, path).split(sep).join('/'))
    if (parsed !== undefined) refusals.set(parsed.module, parsed)
  }
  if (refusals.size === 0) warnings.push('src/shim/**/generated/*.ts: no member-level refusal lists found')

  return {
    root,
    electron: electron.index,
    electronPackages: wrappers.index,
    nodeModules: node.index,
    nativePackages: native.index,
    nativeGlobs: native.globs,
    refusals,
    stats: { electron: electron.stats, electronPackages: wrappers.stats, nodeModules: node.stats, nativePackages: native.stats, refusalModules: refusals.size },
    warnings
  }
}
