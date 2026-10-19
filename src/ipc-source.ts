import { readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import ts from 'typescript'
import { inClone, walk } from './recon.ts'

// The source of an Electron app's IPC surface, parsed on demand: the files under
// the directory that holds preload and main, the string constants a channel name
// is spelled with, and where a function a handler calls is defined. A static
// read, so what it cannot follow it says nothing about.

export interface Source {
  /** Relative to the clone, with "/" on every platform. */
  readonly path: string
  readonly text: string
  readonly tree: ts.SourceFile
}

const MAX_BYTES = 1_000_000
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.cts', '.mts', '.jsx', '/index.ts', '/index.js']

export function parseSource (path: string, text: string): Source {
  const kind = /\.[cm]?ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.TSX
  return { path, text, tree: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind) }
}

export const lineOf = (source: Source, node: ts.Node): number => source.tree.getLineAndCharacterOfPosition(node.getStart(source.tree)).line + 1

export const literalText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

/** Strips the wrappers that do not change a value: parentheses, `as`, `satisfies`, `!`, `await`. */
export function unwrap (node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isAwaitExpression(current)) current = current.expression
  return current
}

export type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | ts.MethodDeclaration

export const isFunctionNode = (node: ts.Node): node is FunctionNode =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)

/** `A.B.C` or `A['B']` as a list of names, or undefined when any link is computed or is not a plain identifier. */
export function dottedName (node: ts.Expression): string[] | undefined {
  const e = unwrap(node)
  if (ts.isIdentifier(e)) return [e.text]
  if (ts.isPropertyAccessExpression(e)) {
    const inner = dottedName(e.expression)
    return inner === undefined ? undefined : [...inner, e.name.text]
  }
  if (ts.isElementAccessExpression(e)) {
    const inner = dottedName(e.expression)
    const key = literalText(e.argumentExpression)
    return inner === undefined || key === undefined ? undefined : [...inner, key]
  }
  return undefined
}

/** An IPC channel as one side of the bridge names it. `name` is the string it evaluates to when the constants could be read. */
export interface Channel {
  readonly text: string
  readonly name: string | undefined
}

/** Whether two channel spellings can be the same channel: equal names, or equal text when neither could be evaluated. */
export function sameChannel (a: Channel, b: Channel): boolean {
  return a.name !== undefined || b.name !== undefined ? a.name === b.name : a.text === b.text
}

export class Universe {
  readonly files: readonly string[]
  readonly #texts: Map<string, string>
  readonly #parsed = new Map<string, Source>()
  readonly #constants = new Map<string, ReadonlyMap<string, string | null>>()

  private constructor (files: readonly string[], texts: Map<string, string>) {
    this.files = files
    this.#texts = texts
  }

  /** Every source file under `dir` (relative to the clone), tests and builds left out. */
  static async load (clone: string, dir: string): Promise<Universe> {
    const texts = new Map<string, string>()
    for (const file of await walk(join(clone, dir))) {
      const path = inClone(clone, file)
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$|(?:^|\/)(?:__tests__|__mocks__|tests?|e2e)\//.test(path) || /\.(?:vue|svelte)$/.test(path)) continue
      if (((await stat(file).catch(() => undefined))?.size ?? 0) > MAX_BYTES) continue
      texts.set(path, await readFile(file, 'utf8').catch(() => ''))
    }
    return new Universe([...texts.keys()].sort(), texts)
  }

  /** Builds a universe from text already in hand, for tests. */
  static of (files: Readonly<Record<string, string>>): Universe {
    const texts = new Map(Object.entries(files))
    return new Universe([...texts.keys()].sort(), texts)
  }

  text (path: string): string | undefined { return this.#texts.get(path) }

  source (path: string): Source | undefined {
    const cached = this.#parsed.get(path)
    if (cached !== undefined) return cached
    const text = this.#texts.get(path)
    if (text === undefined) return undefined
    const source = parseSource(path, text)
    this.#parsed.set(path, source)
    return source
  }

  /** The file a relative specifier names, seen from `from`. */
  resolveImport (from: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined
    const base = posix.normalize(posix.join(posix.dirname(from), specifier))
    const stripped = base.replace(/\.[cm]?[jt]sx?$/, '')
    return [base, stripped].flatMap((stem) => EXTENSIONS.map((ext) => `${stem}${ext}`)).find((path) => this.#texts.has(path))
  }

  /** What the constant `first` holds, as `first.key.sub` -> string (null when two declarations disagree). */
  #constantsNamed (first: string): ReadonlyMap<string, string | null> {
    const known = this.#constants.get(first)
    if (known !== undefined) return known
    const table = new Map<string, string | null>()
    const declared = new RegExp(`(?:\\bconst|\\blet|\\bvar|\\benum|\\bclass)\\s+${first.replace(/\$/g, '\\$')}\\b`)
    for (const path of this.files) {
      if (!declared.test(this.#texts.get(path) as string)) continue
      const source = this.source(path) as Source
      const add = (key: string, value: string): void => {
        const old = table.get(key)
        table.set(key, old === undefined || old === value ? value : null)
      }
      const flatten = (prefix: string, node: ts.Expression): void => {
        const e = unwrap(node)
        const text = literalText(e)
        if (text !== undefined) { add(prefix, text); return }
        if (ts.isCallExpression(e) && e.arguments.length === 1 && /^Object\.freeze$/.test(e.expression.getText(source.tree))) { flatten(prefix, e.arguments[0] as ts.Expression); return }
        if (!ts.isObjectLiteralExpression(e)) return
        for (const property of e.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined
          if (key !== undefined) flatten(`${prefix}.${key}`, property.initializer)
        }
      }
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === first && node.initializer !== undefined) flatten(first, node.initializer)
        if (ts.isEnumDeclaration(node) && node.name.text === first) {
          for (const member of node.members) {
            const value = literalText(member.initializer)
            if (value !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) add(`${first}.${member.name.text}`, value)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source.tree)
    }
    this.#constants.set(first, table)
    return table
  }

  /**
   * The channel an expression names: its string value when it is a literal or a constant
   * the universe declares (`IpcChannels.GET_LOCALE`, an enum member), else its source text.
   */
  channelOf (expression: ts.Expression, from: Source): Channel {
    const e = unwrap(expression)
    const literal = literalText(e)
    if (literal !== undefined) return { text: JSON.stringify(literal), name: literal }
    const text = e.getText(from.tree).replace(/\s+/g, '')
    const dotted = dottedName(e)
    if (dotted === undefined) return { text, name: undefined }
    const [first, ...rest] = dotted as [string, ...string[]]
    const value = this.#constantsNamed(this.#declaredName(first, from)).get([this.#declaredName(first, from), ...rest].join('.'))
    return { text, name: value ?? undefined }
  }

  /** The name an identifier imported under an alias is declared as in its own file. */
  #declaredName (local: string, from: Source): string {
    for (const statement of from.tree.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue
      const clause = statement.importClause
      const named = clause.namedBindings
      if (named !== undefined && ts.isNamedImports(named)) {
        const hit = named.elements.find((element) => element.name.text === local)
        if (hit !== undefined) return (hit.propertyName ?? hit.name).text
      }
      if (clause.name?.text === local && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = this.resolveImport(from.path, statement.moduleSpecifier.text)
        const exported = target === undefined ? undefined : this.source(target)?.tree.statements.find(ts.isExportAssignment)
        const name = exported === undefined ? undefined : unwrap(exported.expression)
        if (name !== undefined && ts.isIdentifier(name)) return name.text
      }
    }
    return local
  }

  /** Every function definition in `paths`, by name; a name defined twice maps to undefined because following either would be a guess. */
  functionsIn (paths: readonly string[]): ReadonlyMap<string, { source: Source; node: FunctionNode } | undefined> {
    const found = new Map<string, { source: Source; node: FunctionNode } | undefined>()
    for (const path of paths) {
      const source = this.source(path)
      if (source === undefined) continue
      const note = (name: string, node: FunctionNode): void => { found.set(name, found.has(name) ? undefined : { source, node }) }
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) note(node.name.text, node)
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
          const init = unwrap(node.initializer)
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) note(node.name.text, init)
        }
        ts.forEachChild(node, visit)
      }
      visit(source.tree)
    }
    return found
  }
}
