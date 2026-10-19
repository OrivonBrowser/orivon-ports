import { builtinModules } from 'node:module'
import ts from 'typescript'

// What one source file asks of Electron, Node and the packages it imports, read
// from TypeScript's parser so a comment, a string or a template never counts.
// A static read: computed keys and dynamic requires are invisible.

export interface FileUses {
  /** `app.getPath`, `dialog`, `process.platform`, `@electron/remote`: what the Electron table has rows for. */
  readonly electron: ReadonlySet<string>
  /** The first argument of each call of an Electron member that has one: a string literal, or null when computed. */
  readonly electronArgs: ReadonlyMap<string, ReadonlySet<string | null>>
  /** `fs`, `fs.readFile`, `fs/promises.readFile`. */
  readonly node: ReadonlySet<string>
  /** Package names imported (`lodash`, `@scope/pkg`), not Node modules, Electron or relative paths. */
  readonly imports: ReadonlySet<string>
  readonly spawns: readonly { readonly fn: string; readonly program: string | undefined }[]
  /** `new BrowserWindow(...)`: the Electron exports the file constructs. */
  readonly constructs: ReadonlySet<string>
  /** The file imports `electron` or `@electron/remote` itself. */
  readonly importsElectron: boolean
  /** `main` when it takes a main-process-only export from `electron`; `preload` when it uses `contextBridge`. */
  readonly hostRole: 'main' | 'preload' | undefined
}

export interface ScanOptions {
  /** The `process.*` names the Electron table has rows for; with none given, `process` is not read. */
  readonly processKeys?: ReadonlySet<string>
  /** Dependencies the app declares: a bare `buffer` among them is that package, not Node's. */
  readonly packages?: ReadonlySet<string>
  /** The file's name, for the script kind. */
  readonly file?: string
  /** Character offsets into the parsed code: bindings are still read from the whole file, but only uses inside the range are recorded. */
  readonly region?: { readonly start: number; readonly end: number }
  /** The file already parsed (with parent links), so scanning many regions of one file parses it once. */
  readonly tree?: ts.SourceFile
}

interface Ref { readonly module: string; readonly path: readonly string[] }

const SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'])
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))
const MAX_DEPTH = 4

/** The exports Electron's documentation lists as main-process modules. */
const MAIN_ONLY = new Set([
  'app', 'autoUpdater', 'BaseWindow', 'BrowserWindow', 'BrowserView', 'contentTracing', 'desktopCapturer', 'dialog', 'globalShortcut',
  'inAppPurchase', 'ipcMain', 'Menu', 'MenuItem', 'MessageChannelMain', 'nativeTheme', 'net', 'netLog', 'Notification', 'powerMonitor',
  'powerSaveBlocker', 'protocol', 'pushNotifications', 'safeStorage', 'screen', 'session', 'ShareMenu', 'systemPreferences', 'TouchBar',
  'Tray', 'utilityProcess', 'View', 'webContents', 'WebContentsView', 'webFrameMain'
])

/** `node:fs` and `fs` are `fs`; a name that is not a Node module is undefined. */
export function nodeModuleName (specifier: string): string | undefined {
  if (specifier.startsWith('node:')) return specifier.slice(5)
  return NODE_BUILTINS.has(specifier) && !specifier.startsWith('_') ? specifier : undefined
}

export function electronSpecifier (specifier: string): string | undefined {
  if (specifier === 'electron' || /^electron\/(?:main|renderer|common|utility)$/.test(specifier)) return specifier
  if (specifier === '@electron/remote' || specifier.startsWith('@electron/remote/') || specifier === 'original-fs') return specifier
  return undefined
}

/** `fs.promises.readFile` is the `readFile` of `fs/promises`. */
function nodeMember (module: string, path: readonly string[]): string {
  const [first, second] = path
  if (first === 'promises' && second !== undefined && ['fs', 'dns', 'stream', 'timers', 'readline'].includes(module)) return `${module}/promises.${second}`
  return first === undefined ? module : `${module}.${first}`
}

function scriptKind (file: string): ts.ScriptKind {
  return /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.TSX
}

/** The text a parser should read: the file, or the `<script>` blocks of a Vue or Svelte component. */
function codeOf (source: string, file: string): string {
  if (!/\.(?:vue|svelte)$/.test(file)) return source
  return [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).join('\n')
}

const literal = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined

function unwrap (node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
  return current
}

/** Whether `await` is among the wrappers around an expression. */
function isAwaited (node: ts.Expression): boolean {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    if (ts.isAwaitExpression(current)) return true
    current = current.expression
  }
  return false
}

/** The member name of `a.b` or `a['b']`, or undefined for a computed key. */
function keyOf (node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  return ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression)
}

const isChain = (node: ts.Node): node is ts.PropertyAccessExpression | ts.ElementAccessExpression =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)

/** `require('x')`, `window.require('x')` or `import('x')`: the specifier. */
function requiredModule (call: ts.CallExpression): string | undefined {
  const callee = call.expression
  const isRequire = (ts.isIdentifier(callee) && callee.text === 'require') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require' && ts.isIdentifier(callee.expression) && ['window', 'global', 'globalThis'].includes(callee.expression.text))
  if (!isRequire && callee.kind !== ts.SyntaxKind.ImportKeyword) return undefined
  return literal(call.arguments[0])
}

export function scanSource (source: string, options: ScanOptions = {}): FileUses {
  const file = options.file ?? 'x.js'
  const processKeys = options.processKeys ?? new Set<string>()
  const packages = options.packages ?? new Set<string>()
  const nodeModule = (specifier: string): string | undefined => specifier.startsWith('node:') || !packages.has(specifier) ? nodeModuleName(specifier) : undefined

  const tree = options.tree ?? ts.createSourceFile(file, codeOf(source, file), ts.ScriptTarget.Latest, true, scriptKind(file))
  const bindings = new Map<string, Ref>()
  const modules = new Set<string>()
  const electron = new Set<string>()
  const electronArgs = new Map<string, Set<string | null>>()
  const node = new Set<string>()
  const constructs = new Set<string>()
  const spawns: { fn: string; program: string | undefined }[] = []
  const region = options.region
  const inRegion = (at: ts.Node): boolean => region === undefined || (at.getStart(tree) >= region.start && at.end <= region.end)
  // Set by `collect` for the node it is on, so a binding made there records its use only inside the region.
  let within = true
  let mainOnly = false
  let bridge = false

  const refOf = (expression: ts.Expression): Ref | undefined => {
    const e = unwrap(expression)
    if (ts.isCallExpression(e)) {
      // import('x') is a promise: only an awaited one stands for the module.
      if (e.expression.kind === ts.SyntaxKind.ImportKeyword && !isAwaited(expression)) return undefined
      const module = requiredModule(e)
      return module === undefined ? undefined : { module, path: [] }
    }
    if (ts.isIdentifier(e)) return bindings.get(e.text)
    if (isChain(e)) {
      const inner = refOf(e.expression)
      const key = keyOf(e)
      return inner === undefined || key === undefined ? undefined : { module: inner.module, path: [...inner.path, key] }
    }
    return undefined
  }

  /** Records a use of `ref`: its Electron name, or its Node module and member. */
  const record = (ref: Ref): string | undefined => {
    const spec = electronSpecifier(ref.module)
    if (spec !== undefined) {
      if (!spec.startsWith('electron') || ref.path.length === 0) return undefined
      const key = ref.path.slice(0, MAX_DEPTH).join('.')
      electron.add(key)
      const first = ref.path[0] as string
      if (MAIN_ONLY.has(first) && (spec === 'electron' || spec === 'electron/main')) mainOnly = true
      if (first === 'contextBridge') bridge = true
      return key
    }
    const name = nodeModule(ref.module)
    if (name !== undefined && ref.path.length > 0) node.add(nodeMember(name, ref.path))
    return undefined
  }

  const bindName = (name: ts.BindingName, ref: Ref): void => {
    if (ts.isIdentifier(name)) {
      bindings.set(name.text, ref)
      if (within) record(ref)
      return
    }
    if (!ts.isObjectBindingPattern(name)) return
    for (const element of name.elements) {
      if (element.dotDotDotToken !== undefined) continue
      const key = element.propertyName === undefined
        ? (ts.isIdentifier(element.name) ? element.name.text : undefined)
        : (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName) ? element.propertyName.text : undefined)
      if (key !== undefined) bindName(element.name, { module: ref.module, path: [...ref.path, key] })
    }
  }

  // Pass 1: every specifier and every binding, in source order so `const { app } = electron` finds `electron`.
  const collect = (node: ts.Node): void => {
    within = inRegion(node)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text
      const clause = node.importClause
      if (clause?.isTypeOnly !== true) {
        if (within) modules.add(module)
        if (clause?.name !== undefined) bindName(clause.name, { module, path: [] })
        const named = clause?.namedBindings
        if (named !== undefined && ts.isNamespaceImport(named)) bindName(named.name, { module, path: [] })
        else if (named !== undefined) {
          for (const element of named.elements) {
            if (!element.isTypeOnly) bindName(element.name, { module, path: [(element.propertyName ?? element.name).text] })
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const module = literal(node.moduleReference.expression)
      if (module !== undefined) { if (within) modules.add(module); bindName(node.name, { module, path: [] }) }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && !node.isTypeOnly) {
      const module = literal(node.moduleSpecifier)
      if (module !== undefined && within) modules.add(module)
    } else if (ts.isCallExpression(node)) {
      const module = requiredModule(node)
      if (module !== undefined && within) modules.add(module)
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const ref = refOf(node.initializer)
      if (ref !== undefined) bindName(node.name, ref)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const ref = refOf(node.right)
      if (ref !== undefined) bindName(node.left, ref)
    }
    ts.forEachChild(node, collect)
  }
  collect(tree)

  // Pass 2: member chains read off a bound name, and calls that start a process.
  const reads = (current: ts.Node): void => {
    const here = inRegion(current)
    if (here && isChain(current) && !(current.parent !== undefined && isChain(current.parent) && current.parent.expression === current)) {
      const names: string[] = []
      let root: ts.Expression = current
      while (isChain(root)) {
        const key = keyOf(root)
        if (key === undefined) break
        names.unshift(key)
        root = unwrap(root.expression)
      }
      if (!isChain(root)) chainRead(current, root, names)
    }
    if (here && ts.isCallExpression(current)) spawnRead(current)
    if (here && ts.isNewExpression(current)) constructRead(current)
    ts.forEachChild(current, reads)
  }

  const chainRead = (chain: ts.Expression, root: ts.Expression, names: string[]): void => {
    if (ts.isIdentifier(root) && root.text === 'process' && !bindings.has('process')) {
      if (processKeys.size === 0) return
      const hit = [names.slice(0, 2), names.slice(0, 1)].map((parts) => `process.${parts.join('.')}`).find((key) => processKeys.has(key))
      if (hit !== undefined) electron.add(hit)
      return
    }
    const ref = refOf(root)
    if (ref === undefined) return
    const key = record({ module: ref.module, path: [...ref.path, ...names] })
    const call = chain.parent
    if (key !== undefined && call !== undefined && ts.isCallExpression(call) && call.expression === chain && call.arguments.length > 0) {
      const set = electronArgs.get(key) ?? new Set<string | null>()
      set.add(literal(call.arguments[0]) ?? null)
      electronArgs.set(key, set)
    }
  }

  const constructRead = (made: ts.NewExpression): void => {
    const ref = refOf(made.expression)
    if (ref !== undefined && electronSpecifier(ref.module)?.startsWith('electron') === true && ref.path.length > 0) constructs.add(ref.path.join('.'))
  }

  const spawnRead = (call: ts.CallExpression): void => {
    const ref = refOf(call.expression)
    if (ref === undefined || nodeModule(ref.module) !== 'child_process' || ref.path.length !== 1) return
    const fn = ref.path[0] as string
    if (!SPAWNERS.has(fn) || call.arguments.length === 0) return
    const value = literal(call.arguments[0])
    const program = value === undefined ? undefined : fn.startsWith('exec') && fn !== 'execFile' && fn !== 'execFileSync' ? (value.trim().split(/\s+/)[0] ?? '') : value
    spawns.push({ fn, program })
  }
  reads(tree)

  for (const specifier of modules) {
    const spec = electronSpecifier(specifier)
    if (spec !== undefined && spec !== 'electron') electron.add(spec.startsWith('@electron/remote') ? '@electron/remote' : spec)
    const name = nodeModule(specifier)
    if (name !== undefined) node.add(name)
  }
  const imports = new Set<string>()
  for (const specifier of modules) {
    if (/^[./]/.test(specifier) || electronSpecifier(specifier) !== undefined || nodeModule(specifier) !== undefined) continue
    imports.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] as string)
  }
  const importsElectron = [...modules].some((specifier) => electronSpecifier(specifier) !== undefined && specifier !== 'original-fs')
  return { electron, electronArgs, node, imports, spawns, constructs, importsElectron, hostRole: mainOnly ? 'main' : bridge ? 'preload' : undefined }
}
