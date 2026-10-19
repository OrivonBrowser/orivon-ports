import ts from 'typescript'
import { isFunctionNode, lineOf, literalText, sameChannel } from './ipc-source.ts'
import type { Channel, FunctionNode, Source, Universe } from './ipc-source.ts'

// Where the main process sends a channel the renderer listens on, and what makes
// each send happen. A listener is inert in Orivon only when every send is one a
// single-window browser never triggers; one send from anywhere else, or one whose
// channel could not be read, and the evidence is not clear.

export interface SendContext {
  readonly inert: boolean
  readonly why: string
}

export interface SendSite {
  readonly where: string
  readonly contexts: readonly SendContext[]
}

export interface SendVerdict {
  readonly sites: readonly SendSite[]
  /** Sends whose channel is neither a literal nor a constant the scan could read: any of them might be this channel. */
  readonly unresolved: number
}

const SECOND_INSTANCE_EVENTS = new Set(['second-instance', 'open-url', 'open-file'])
const RECEIVER = /webContents|sender|[Ff]rame|[Ww]indow|\bwin\b|\bevent\b|\bview\b|contents/
const MAX_LINKS = 6

interface Site {
  readonly source: Source
  readonly call: ts.CallExpression
  readonly channel: Channel
  /** The parameter the channel was passed in, when the send is inside a helper that takes the channel as an argument. */
  readonly param?: { readonly fn: FunctionNode; readonly index: number }
}

const INERT_OTHERS = 'it goes only to the other windows (the code iterates getAllWindows and skips the sender), and a single-window browser has none'
const INERT_SECOND = 'it is sent while handling a second launch, a deep link or a file open, which the browser never starts'
const INERT_MENU = 'it is sent from a native application menu click, and the browser shows no menu for the app'

function nameOfFunction (fn: FunctionNode): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text
  return ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : undefined
}

export class SendIndex {
  readonly #universe: Universe
  readonly #sources: Source[]
  readonly #sites: Site[] = []
  readonly #references = new Map<string, { source: Source; node: ts.Identifier }[]>()

  constructor (universe: Universe, files: readonly string[]) {
    this.#universe = universe
    this.#sources = files.map((path) => universe.source(path)).filter((source): source is Source => source !== undefined)
    for (const source of this.#sources) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length > 0) {
          const method = node.expression.name.text
          if ((method === 'send' && RECEIVER.test(node.expression.expression.getText(source.tree))) || method === 'reply') this.#note(source, node)
        }
        ts.forEachChild(node, visit)
      }
      visit(source.tree)
    }
  }

  #note (source: Source, call: ts.CallExpression): void {
    const first = call.arguments[0] as ts.Expression
    let fn: ts.Node | undefined = call.parent
    while (fn !== undefined && !isFunctionNode(fn)) fn = fn.parent
    const index = ts.isIdentifier(first) && fn !== undefined && isFunctionNode(fn) ? fn.parameters.findIndex((parameter) => parameter.name.getText(source.tree) === first.text) : -1
    const channel = this.#universe.channelOf(first, source)
    this.#sites.push(fn !== undefined && isFunctionNode(fn) && index >= 0 ? { source, call, channel, param: { fn, index } } : { source, call, channel })
  }

  /** Every identifier in the searched files that names `name` and is not where it is declared, imported or a property of something else. */
  #referencesTo (name: string): { source: Source; node: ts.Identifier }[] {
    const known = this.#references.get(name)
    if (known !== undefined) return known
    const found: { source: Source; node: ts.Identifier }[] = []
    for (const source of this.#sources) {
      if (!source.text.includes(name)) continue
      const visit = (node: ts.Node): void => {
        const parent = node.parent as ts.Node | undefined
        const declared = parent !== undefined && ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isParameter(parent)) && parent.name === node)
        const member = parent !== undefined && ts.isPropertyAccessExpression(parent) && parent.name === node
        const imported = parent !== undefined && (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isExportSpecifier(parent))
        if (ts.isIdentifier(node) && node.text === name && !declared && !member && !imported) found.push({ source, node })
        ts.forEachChild(node, visit)
      }
      visit(source.tree)
    }
    this.#references.set(name, found)
    return found
  }

  #othersOnly (fn: FunctionNode, source: Source): boolean {
    const text = fn.getText(source.tree)
    return /getAllWindows|getAllWebContents/.test(text) && /(?:!==|!=)\s*[\w.]*sender|sender[\w.]*\s*(?:!==|!=)/.test(text)
  }

  /** The reasons code at `node` runs, by climbing out of it: through the callbacks it sits in, then through whoever calls the function it is in. */
  #climb (node: ts.Node, links: number, seen: Set<ts.Node>, inertChannel: (channel: Channel) => boolean, out: SendContext[]): void {
    const source = this.#sources.find((candidate) => candidate.tree === node.getSourceFile()) as Source
    let child: ts.Node = node
    for (let ancestor: ts.Node | undefined = node.parent; ancestor !== undefined; child = ancestor, ancestor = ancestor.parent) {
      // A function passed by name to a registration (`ipcMain.on(channel, handler)`) runs for whatever that registration listens to.
      if (ts.isCallExpression(ancestor) && ts.isIdentifier(child) && ancestor.arguments.includes(child) && this.#registration(ancestor, source, inertChannel, out)) return
      if (!isFunctionNode(ancestor)) continue
      if (this.#othersOnly(ancestor, source)) { out.push({ inert: true, why: INERT_OTHERS }); return }
      const parent = ancestor.parent as ts.Node
      if (ts.isPropertyAssignment(parent) && parent.name.getText(source.tree) === 'click') { out.push({ inert: true, why: INERT_MENU }); return }
      if (ts.isCallExpression(parent) && parent.arguments.includes(ancestor as unknown as ts.Expression)) {
        if (this.#registration(parent, source, inertChannel, out)) return
        continue
      }
      const name = nameOfFunction(ancestor)
      if (name === undefined) continue
      if (seen.has(ancestor)) return
      seen.add(ancestor)
      const callers = this.#referencesTo(name)
      if (links === 0 || callers.length === 0) {
        out.push({ inert: false, why: callers.length === 0 ? `\`${name}\` is not called from the files searched` : `reached through \`${name}\`, more calls deep than this follows` })
        return
      }
      for (const caller of callers) this.#climb(caller.node, links - 1, seen, inertChannel, out)
      return
    }
    out.push({ inert: false, why: 'runs at start-up or on an event this scan does not recognise' })
  }

  /** Whether a callback passed to `call` ends the climb: it names what makes the callback run. */
  #registration (call: ts.CallExpression, source: Source, inertChannel: (channel: Channel) => boolean, out: SendContext[]): boolean {
    if (!ts.isPropertyAccessExpression(call.expression)) return false
    const receiver = call.expression.expression.getText(source.tree)
    const method = call.expression.name.text
    const first = call.arguments[0]
    if (/(?:^|\.)ipcMain$/.test(receiver) && ['handle', 'handleOnce', 'on', 'once'].includes(method) && first !== undefined) {
      const channel = this.#universe.channelOf(first, source)
      out.push({ inert: inertChannel(channel), why: `answers the renderer's \`${channel.name ?? channel.text}\` message` })
      return true
    }
    if (/(?:^|\.)app$/.test(receiver) && (method === 'on' || method === 'once')) {
      const event = literalText(first)
      out.push(event !== undefined && SECOND_INSTANCE_EVENTS.has(event) ? { inert: true, why: INERT_SECOND } : { inert: false, why: `runs on the app event ${event === undefined ? '(computed)' : `"${event}"`}` })
      return true
    }
    return false
  }

  /** What makes main send `channel`, for each place it does. */
  verdict (channel: Channel, inertChannel: (channel: Channel) => boolean): SendVerdict {
    const sites: SendSite[] = []
    let unresolved = 0
    for (const site of this.#sites) {
      const where = `${site.source.path}:${String(lineOf(site.source, site.call))}`
      if (site.param === undefined) {
        if (site.channel.name === undefined && !sameChannel(site.channel, channel)) unresolved++
        if (!sameChannel(site.channel, channel)) continue
        const contexts: SendContext[] = []
        this.#climb(site.call, MAX_LINKS, new Set(), inertChannel, contexts)
        sites.push({ where, contexts })
        continue
      }
      const helper = nameOfFunction(site.param.fn)
      if (helper === undefined) { unresolved++; continue }
      if (this.#othersOnly(site.param.fn, site.source)) {
        // A helper that only reaches other windows is inert for every channel it carries, so the callers decide only whether this channel passes through it.
        const callers = this.#referencesTo(helper).filter((caller) => this.#passes(caller.node, site.param?.index ?? 0, channel))
        if (callers.length > 0) sites.push({ where, contexts: [{ inert: true, why: INERT_OTHERS }] })
        continue
      }
      for (const caller of this.#referencesTo(helper)) {
        const passed = this.#argumentOf(caller.node, site.param.index)
        if (passed === undefined) continue
        const named = this.#universe.channelOf(passed, caller.source)
        if (named.name === undefined && !sameChannel(named, channel)) unresolved++
        if (!sameChannel(named, channel)) continue
        const contexts: SendContext[] = []
        this.#climb(caller.node, MAX_LINKS, new Set(), inertChannel, contexts)
        sites.push({ where: `${caller.source.path}:${String(lineOf(caller.source, caller.node))}`, contexts })
      }
    }
    return { sites, unresolved }
  }

  #argumentOf (callee: ts.Identifier, index: number): ts.Expression | undefined {
    const call = callee.parent
    return ts.isCallExpression(call) && call.expression === callee ? call.arguments[index] : undefined
  }

  #passes (callee: ts.Identifier, index: number, channel: Channel): boolean {
    const passed = this.#argumentOf(callee, index)
    return passed !== undefined && sameChannel(this.#universe.channelOf(passed, this.#sources.find((candidate) => candidate.tree === callee.getSourceFile()) as Source), channel)
  }
}
