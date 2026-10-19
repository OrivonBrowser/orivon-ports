import ts from 'typescript'
import { isFunctionNode, lineOf, literalText, unwrap } from './ipc-source.ts'
import { scanSource } from './source-ast.ts'
import type { Channel, FunctionNode, Source, Universe } from './ipc-source.ts'

// The main-process half of the seam: the `ipcMain` handler behind each channel, the
// Electron and Node APIs it calls (one function away, and two), and the two shapes a
// handler can have that mean something without reading its APIs: it returns a literal,
// or it only stores its argument in a variable nothing else reads.

export interface Handler {
  readonly channel: Channel
  readonly how: 'handle' | 'handleOnce' | 'on' | 'once'
  /** `ipcMain` serves every window; a `webContents.ipc` handler serves the one it hangs on. */
  readonly scope: 'app' | 'window'
  readonly source: Source
  readonly line: number
  /** Where the handler body is, and the function it lives in; undefined when the callback is computed. */
  readonly fn: { readonly source: Source; readonly node: FunctionNode } | undefined
}

export interface Effects {
  /** `powerSaveBlocker.start`, `session.defaultSession.setProxy`: every Electron member the handler reaches. */
  readonly electron: ReadonlySet<string>
  readonly electronArgs: ReadonlyMap<string, ReadonlySet<string | null>>
  readonly node: ReadonlySet<string>
  /** `new BrowserWindow`: the Electron exports it constructs. */
  readonly constructs: ReadonlySet<string>
  readonly spawns: readonly string[]
  /** The function a use was found in when it was not the handler itself: api -> function name. */
  readonly via: ReadonlyMap<string, string>
}

const REGISTER = new Set(['handle', 'handleOnce', 'on', 'once'])
const MAX_FOLLOWED = 25

export type FunctionIndex = ReadonlyMap<string, { source: Source; node: FunctionNode } | undefined>

export function handlersIn (universe: Universe, files: readonly string[], functions: FunctionIndex): Handler[] {
  const found: Handler[] = []
  for (const path of files) {
    const text = universe.text(path)
    if (text === undefined || !/\bipc(?:Main)?\b/.test(text)) continue
    const source = universe.source(path) as Source
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && REGISTER.has(node.expression.name.text) && node.arguments.length >= 2) {
        const receiver = node.expression.expression.getText(source.tree)
        const scope = /(?:^|\.)ipcMain$/.test(receiver) ? 'app' : /(?:^|\.)ipc$/.test(receiver) ? 'window' : undefined
        if (scope !== undefined) {
          const callback = unwrap(node.arguments[1] as ts.Expression)
          const fn = isFunctionNode(callback)
            ? { source, node: callback }
            : ts.isIdentifier(callback) ? functions.get(callback.text) : undefined
          found.push({ channel: universe.channelOf(node.arguments[0] as ts.Expression, source), how: node.expression.name.text as Handler['how'], scope, source, line: lineOf(source, node), fn })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source.tree)
  }
  return found
}

interface Acc {
  electron: Set<string>
  electronArgs: Map<string, Set<string | null>>
  node: Set<string>
  constructs: Set<string>
  spawns: string[]
  via: Map<string, string>
}

/** The APIs a function calls, and those of the functions it calls by name, down to `depth` links. */
export function effectsOf (fn: { source: Source; node: ts.Node }, functions: FunctionIndex, depth = 1): Effects {
  const acc: Acc = { electron: new Set(), electronArgs: new Map(), node: new Set(), constructs: new Set(), spawns: [], via: new Map() }
  const seen = new Set<ts.Node>()
  let followed = 0
  const scan = (target: { source: Source; node: ts.Node }, links: number, name: string | undefined): void => {
    seen.add(target.node)
    const uses = scanSource(target.source.text, { file: target.source.path, tree: target.source.tree, region: { start: target.node.getStart(target.source.tree), end: target.node.end } })
    const note = (set: Set<string>, values: Iterable<string>): void => {
      for (const value of values) {
        if (name !== undefined && !acc.electron.has(value) && !acc.node.has(value) && !acc.constructs.has(value) && !acc.via.has(value)) acc.via.set(value, name)
        set.add(value)
      }
    }
    // The seam itself (`ipcMain.handle`, `ipcRenderer.send`) says nothing about what the handler does.
    note(acc.electron, [...uses.electron].filter((api) => !/^ipc(?:Main|Renderer)(?:\.|$)/.test(api)))
    note(acc.node, uses.node)
    note(acc.constructs, [...uses.constructs].map((made) => `new ${made}`))
    for (const [api, args] of uses.electronArgs) {
      const merged = acc.electronArgs.get(api) ?? new Set<string | null>()
      for (const arg of args) merged.add(arg)
      acc.electronArgs.set(api, merged)
    }
    for (const call of uses.spawns) acc.spawns.push(`${call.fn}(${call.program ?? '?'})`)
    if (links === 0) return
    const visit = (current: ts.Node): void => {
      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && followed < MAX_FOLLOWED) {
        const callee = functions.get(current.expression.text)
        if (callee !== undefined && !seen.has(callee.node)) {
          followed++
          scan(callee, links - 1, current.expression.text)
        }
      }
      ts.forEachChild(current, visit)
    }
    visit(target.node)
  }
  scan(fn, depth, undefined)
  return { electron: acc.electron, electronArgs: acc.electronArgs, node: acc.node, constructs: acc.constructs, spawns: acc.spawns, via: acc.via }
}

/** A literal a handler can return and a bridge can state: a string, number, boolean, null, or an object or array of them. */
export function literalValue (node: ts.Expression): { value: unknown } | undefined {
  const e = unwrap(node)
  const text = literalText(e)
  if (text !== undefined) return { value: text }
  if (ts.isNumericLiteral(e)) return { value: Number(e.text) }
  if (e.kind === ts.SyntaxKind.TrueKeyword) return { value: true }
  if (e.kind === ts.SyntaxKind.FalseKeyword) return { value: false }
  if (e.kind === ts.SyntaxKind.NullKeyword) return { value: null }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return { value: -Number(e.operand.text) }
  if (ts.isArrayLiteralExpression(e)) {
    const items = e.elements.map((item) => literalValue(item))
    return items.every((item) => item !== undefined) ? { value: items.map((item) => (item as { value: unknown }).value) } : undefined
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {}
    for (const property of e.properties) {
      const key = ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined
      const value = key === undefined ? undefined : literalValue((property as ts.PropertyAssignment).initializer)
      if (key === undefined || value === undefined) return undefined
      out[key] = value.value
    }
    return { value: out }
  }
  return undefined
}

/** `if (guard) return` at the top of a body: a check on the sender, which changes nothing the handler answers. */
const isGuard = (statement: ts.Statement): boolean =>
  ts.isIfStatement(statement) && statement.elseStatement === undefined &&
  (ts.isReturnStatement(statement.thenStatement) ? statement.thenStatement.expression === undefined
    : ts.isBlock(statement.thenStatement) && statement.thenStatement.statements.length === 1 && ts.isReturnStatement(statement.thenStatement.statements[0] as ts.Statement) &&
      (statement.thenStatement.statements[0] as ts.ReturnStatement).expression === undefined)

/** The one literal a handler returns, ignoring leading `if (...) return` guards; undefined when it does anything else. */
export function constantReturn (fn: FunctionNode): { value: unknown } | undefined {
  const body = fn.body
  if (body === undefined) return undefined
  if (!ts.isBlock(body)) return literalValue(body)
  const rest = body.statements.filter((statement) => !isGuard(statement))
  const only = rest[0]
  return rest.length === 1 && only !== undefined && ts.isReturnStatement(only) && only.expression !== undefined ? literalValue(only.expression) : undefined
}

/**
 * Whether a handler only stores what it is given: every statement (after the guards) assigns a
 * call-free expression to a variable declared outside it, and no other code in the file reads
 * that variable. Returns the variables, or undefined when the handler does more.
 */
export function stateOnly (fn: { source: Source; node: FunctionNode }): string[] | undefined {
  const body = fn.node.body
  if (body === undefined || !ts.isBlock(body)) return undefined
  const statements = body.statements.filter((statement) => !isGuard(statement))
  const targets = new Set<string>()
  const callFree = (expression: ts.Node): boolean => {
    let free = true
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node) || ts.isFunctionLike(node)) free = false
      else ts.forEachChild(node, visit)
    }
    visit(expression)
    return free
  }
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement)) return undefined
    const e = unwrap(statement.expression)
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !callFree(e.right)) return undefined
    let root: ts.Expression = e.left
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression
    if (!ts.isIdentifier(root) || fn.node.parameters.some((parameter) => parameter.name.getText(fn.source.tree) === (root as ts.Identifier).text)) return undefined
    targets.add(root.text)
  }
  if (targets.size === 0) return undefined
  // A variable something else reads is state the app uses; only an unread one is safe to call inert.
  let readElsewhere = false
  const visit = (node: ts.Node): void => {
    if (node === fn.node) return
    if (ts.isIdentifier(node) && targets.has(node.text) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) readElsewhere = true
    ts.forEachChild(node, visit)
  }
  visit(fn.source.tree)
  return readElsewhere ? undefined : [...targets]
}
