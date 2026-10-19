import ts from 'typescript'
import { isFunctionNode, lineOf, literalText, unwrap } from './ipc-source.ts'
import type { Channel, FunctionNode, Source, Universe } from './ipc-source.ts'

// What each member of an `exposeInMainWorld` object does at the IPC seam: which
// `ipcRenderer` call it makes and on which channel. The object is followed through
// a variable, an import (one hop per link) and a factory function; whatever is
// computed past that is reported as a member with no IPC use, never guessed.

export type IpcKind = 'invoke' | 'send' | 'sendSync' | 'on' | 'once'

export interface IpcUse {
  readonly kind: IpcKind
  readonly channel: Channel
  readonly line: number
}

export interface PreloadMember {
  readonly global: string
  readonly member: string
  readonly source: Source
  /** The node whose body is the member: its function, or the property's value when that is not one. */
  readonly node: ts.Node
  readonly line: number
  readonly uses: readonly IpcUse[]
}

const IPC_METHODS = new Set<string>(['invoke', 'send', 'sendSync', 'on', 'once'])
const MAX_LINKS = 5

const nameOf = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined

/** A variable or function declared anywhere in the file under this name. */
function declaredIn (source: Source, name: string): ts.Expression | FunctionNode | undefined {
  let found: ts.Expression | FunctionNode | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined) found = node.initializer
    else if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(source.tree)
  return found
}

/** The statement that imports `local`, and the name it has in the module it comes from. */
function importOf (source: Source, local: string): { specifier: string; imported: string } | undefined {
  for (const statement of source.tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause === undefined) continue
    const clause = statement.importClause
    if (clause.name?.text === local) return { specifier: statement.moduleSpecifier.text, imported: 'default' }
    const named = clause.namedBindings
    const hit = named !== undefined && ts.isNamedImports(named) ? named.elements.find((element) => element.name.text === local) : undefined
    if (hit !== undefined) return { specifier: statement.moduleSpecifier.text, imported: (hit.propertyName ?? hit.name).text }
  }
  return undefined
}

/** What a function hands back: an expression body, or the last top-level `return`. */
function returned (fn: FunctionNode): ts.Expression | undefined {
  const body = fn.body
  if (body === undefined) return undefined
  if (!ts.isBlock(body)) return body
  const last = [...body.statements].reverse().find(ts.isReturnStatement)
  return last?.expression
}

interface Located<T extends ts.Node> { readonly source: Source; readonly node: T }

/** The object literal an expression stands for, wherever it is declared. */
function objectOf (universe: Universe, source: Source, expression: ts.Expression, links = MAX_LINKS): Located<ts.ObjectLiteralExpression> | undefined {
  if (links === 0) return undefined
  const e = unwrap(expression)
  if (ts.isObjectLiteralExpression(e)) return { source, node: e }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const target = definition(universe, source, e.expression.text)
    const result = target === undefined || !isFunctionNode(target.node) ? undefined : returned(target.node)
    return target === undefined || result === undefined ? undefined : objectOf(universe, target.source, result, links - 1)
  }
  if (!ts.isIdentifier(e)) return undefined
  const target = definition(universe, source, e.text)
  if (target === undefined) return undefined
  return isFunctionNode(target.node) ? undefined : objectOf(universe, target.source, target.node, links - 1)
}

/** The declaration an identifier names in its own file, or in the file it is imported from. */
function definition (universe: Universe, source: Source, name: string): Located<ts.Expression | FunctionNode> | undefined {
  const local = declaredIn(source, name)
  if (local !== undefined) return { source, node: local }
  const imported = importOf(source, name)
  const path = imported === undefined ? undefined : universe.resolveImport(source.path, imported.specifier)
  const target = path === undefined ? undefined : universe.source(path)
  if (imported === undefined || target === undefined) return undefined
  if (imported.imported === 'default') {
    const exported = target.tree.statements.find(ts.isExportAssignment)
    return exported === undefined ? undefined : { source: target, node: exported.expression }
  }
  const inner = declaredIn(target, imported.imported)
  return inner === undefined ? undefined : { source: target, node: inner }
}

/** The member function an object property stands for: itself, or the function its value names. */
function memberNode (universe: Universe, source: Source, value: ts.Node): ts.Node {
  if (ts.isExpression(value)) {
    const e = unwrap(value)
    if (ts.isIdentifier(e)) {
      const target = definition(universe, source, e.text)
      if (target !== undefined && isFunctionNode(target.node)) return target.node
      if (target !== undefined && ts.isExpression(target.node) && isFunctionNode(unwrap(target.node))) return unwrap(target.node)
    }
    return e
  }
  return value
}

function ipcUses (universe: Universe, source: Source, node: ts.Node): IpcUse[] {
  const uses: IpcUse[] = []
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && IPC_METHODS.has(current.expression.name.text) &&
      /(?:^|\.)ipcRenderer$/.test(current.expression.expression.getText(source.tree)) && current.arguments.length > 0) {
      uses.push({ kind: current.expression.name.text as IpcKind, channel: universe.channelOf(current.arguments[0] as ts.Expression, source), line: lineOf(source, current) })
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return uses
}

function membersOf (universe: Universe, global: string, located: Located<ts.ObjectLiteralExpression>, depth: number): PreloadMember[] {
  const { source, node } = located
  const members: PreloadMember[] = []
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property) && depth > 0) {
      const inner = objectOf(universe, source, property.expression)
      if (inner !== undefined) members.push(...membersOf(universe, global, inner, depth - 1))
      continue
    }
    if (!(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property) || ts.isShorthandPropertyAssignment(property))) continue
    const member = nameOf(property.name)
    if (member === undefined) continue
    const value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : property
    const body = memberNode(universe, source, value)
    members.push({ global, member, source, node: body, line: lineOf(source, property), uses: ipcUses(universe, source, body) })
  }
  return members
}

/** Every member of every global the given files expose, in the order the preload lists them. */
export function preloadMembers (universe: Universe, files: readonly string[]): PreloadMember[] {
  const found: PreloadMember[] = []
  for (const path of files) {
    const text = universe.text(path)
    if (text === undefined || !text.includes('exposeInMainWorld')) continue
    const source = universe.source(path) as Source
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'exposeInMainWorld' && node.arguments.length >= 2) {
        const global = literalText(node.arguments[0])
        const object = global === undefined ? undefined : objectOf(universe, source, node.arguments[1] as ts.Expression)
        if (global !== undefined && object !== undefined) found.push(...membersOf(universe, global, object, 2))
      }
      ts.forEachChild(node, visit)
    }
    visit(source.tree)
  }
  return found
}
