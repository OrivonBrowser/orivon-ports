import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG } from './catalog.ts'
import { DeclarationError, parseDeclaration } from './declaration.ts'
import type { Buckets, Declaration, ValueMember } from './declaration.ts'
import type { Recipe, RecipeDirs } from '../recipe.ts'

// The served bridge, assembled: the kit's own runtime, then the members the
// declaration generates, then the app's own file, then one install call. It
// is still what it always was -- a classic, synchronous script injected first
// in <head> -- and it still reads like one, because every `why` in the
// declaration comes out as the comment above the member it explains.

const RUNTIME = fileURLToPath(new URL('runtime/', import.meta.url))

const APP_MEMBERS = /\bfunction\s+appMembers\s*\(/

interface Group {
  readonly bucket: string
  readonly binding: string
  readonly code: string
}

/** A `why` is prose a person wrote, so it is wrapped rather than emitted as one long line -- the generated bridge is read, not only run. */
function comment (text: string, indent = ''): string {
  const width = 78 - indent.length
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.trim().split(/\s+/)) {
      if (line === '') line = word
      else if (`${line} ${word}`.length > width) { lines.push(line); line = word }
      else line += ` ${word}`
    }
    lines.push(line)
  }
  return lines.map((line) => `${indent}// ${line}`).join('\n')
}

/** Single-quoted, like everything else in a bridge. JSON.stringify would emit double quotes into a file that is otherwise not JSON. */
function quote (text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/** A constant's value as a JS literal. An object or array is parenthesised, because `() => {}` is a function body and `() => []` is not what an arrow returning one reads as. */
function literal (value: unknown): string {
  if (typeof value === 'string') return quote(value)
  const json = JSON.stringify(value)
  return typeof value === 'object' && value !== null ? `(${json})` : json
}

function members (entries: readonly string[]): string {
  return entries.join('\n')
}

function behaviourGroup (buckets: Buckets, owner: string): Group | undefined {
  const ids = Object.keys(buckets.behaviours)
  if (ids.length === 0) return undefined
  const lines = ids.map((id) => {
    const roles = buckets.behaviours[id] as Record<string, string>
    const named = Object.entries(roles).map(([role, name]) => `${role}: ${quote(name)}`).join(', ')
    return `${comment((CATALOG[id] as { summary: string }).summary, '  ')}\n  BEHAVIOURS.${id}({ ${named} }, ${quote(owner)})`
  })
  return { bucket: 'behaviours', binding: `${owner}$behaviours`, code: `const ${owner}$behaviours = Object.assign(\n  {},\n${lines.join(',\n')}\n)` }
}

function recorderGroup (buckets: Buckets, owner: string): Group | undefined {
  const group = buckets.listeners
  if (group === undefined) return undefined
  const lines = group.members.map((name) => `  ${name}: recorder(${quote(owner)}, ${quote(name)})`)
  return {
    bucket: 'listeners',
    binding: `${owner}$listeners`,
    code: `${comment(group.why)}\nconst ${owner}$listeners = {\n${lines.join(',\n')}\n}`
  }
}

function noopGroup (buckets: Buckets, owner: string): Group | undefined {
  const group = buckets.noop
  if (group === undefined) return undefined
  const lines = group.members.map((name) => `  ${name}: () => {}`)
  return {
    bucket: 'noop',
    binding: `${owner}$noop`,
    code: `${comment(group.why)}\nconst ${owner}$noop = {\n${lines.join(',\n')}\n}`
  }
}

function valueGroup (entries: Readonly<Record<string, ValueMember>>, owner: string, bucket: string, prefix: string): Group | undefined {
  const names = Object.keys(entries)
  if (names.length === 0) return undefined
  const binding = `${owner}$${bucket}`
  const lines = names.map((name) => {
    const entry = entries[name] as ValueMember
    return `${comment(entry.why, '  ')}\n  ${name}: ${prefix}() => ${literal(entry.value)}`
  })
  return { bucket, binding, code: `const ${binding} = {\n${lines.join(',\n')}\n}` }
}

function refusedGroup (buckets: Buckets, owner: string): Group | undefined {
  const names = Object.keys(buckets.refused)
  if (names.length === 0) return undefined
  const lines = names.map((name) => {
    const entry = buckets.refused[name] as { reason: string, detail?: string, why: string }
    const args = [quote(name), quote(entry.reason), entry.detail === undefined ? 'undefined' : quote(entry.detail), quote(owner)]
    return `${comment(entry.why, '  ')}\n  ${name}: refuse(${args.join(', ')})`
  })
  return { bucket: 'refused', binding: `${owner}$refused`, code: `const ${owner}$refused = {\n${lines.join(',\n')}\n}` }
}

function groupsFor (buckets: Buckets, owner: string): Group[] {
  return [
    behaviourGroup(buckets, owner),
    recorderGroup(buckets, owner),
    noopGroup(buckets, owner),
    valueGroup(buckets.constants, owner, 'constants', ''),
    valueGroup(buckets.asyncConstants, owner, 'asyncConstants', 'async '),
    refusedGroup(buckets, owner)
  ].filter((group): group is Group => group !== undefined)
}

export interface ComposeInput {
  readonly declaration: Declaration
  /** Where the declaration came from, for the generated header and for error messages. */
  readonly declarationPath: string
  /** The app's own bridge file, when it has one. Required exactly when `hand` is non-empty. */
  readonly appFragment?: { readonly path: string, readonly source: string }
  readonly runtime: { readonly preamble: string, readonly behaviours: string }
}

export function composeBridge (input: ComposeInput): string {
  const { declaration } = input
  const fragment = input.appFragment
  const names = Object.keys(declaration.globals)
  const hand = names.flatMap((name) => (declaration.globals[name] as Buckets).hand)

  if (hand.length > 0 && fragment === undefined) {
    throw new DeclarationError(`${input.declarationPath}: "hand" names ${hand.join(', ')}, so the recipe needs a bridge.file supplying them`)
  }
  if (hand.length === 0 && fragment !== undefined) {
    throw new DeclarationError(`${fragment.path}: nothing to supply -- no global in ${input.declarationPath} declares a "hand" member, so either declare the members it provides or drop bridge.file`)
  }
  if (fragment !== undefined && !APP_MEMBERS.test(fragment.source)) {
    throw new DeclarationError(`${fragment.path}: must declare \`function appMembers (kit)\` returning ${hand.join(', ')} -- it is spliced into the composed bridge, not imported`)
  }

  const sections: string[] = []
  const installs: string[] = []
  for (const name of names) {
    const buckets = declaration.globals[name] as Buckets
    const groups = groupsFor(buckets, name)
    if (names.length > 1) sections.push(`// --- ${name} ---`, '')
    sections.push(...groups.map((group) => `${group.code}\n`))
    const entries = groups.map((group) => `    [${quote(group.bucket)}, ${group.binding}]`)
    installs.push(`  [${quote(name)}, [\n${entries.join(',\n')}\n  ], [${buckets.hand.map(quote).join(', ')}]]`)
  }

  const header = fragment === undefined
    ? `// Generated by orivon-port from ${input.declarationPath}.`
    : `// Generated by orivon-port from ${input.declarationPath} and ${fragment.path}.`

  return members([
    header,
    '// Edit those, never this file -- the next build writes it again.',
    ';(function () {',
    "'use strict'",
    `const GLOBALS = [${names.map(quote).join(', ')}]`,
    '',
    '// ---- kit: src/bridge/runtime/preamble.js ----',
    input.runtime.preamble,
    '// ---- kit: src/bridge/runtime/behaviours.js ----',
    input.runtime.behaviours,
    `// ---- declared: ${input.declarationPath} ----`,
    '',
    ...sections,
    ...(fragment === undefined ? [] : [`// ---- app: ${fragment.path} ----`, '', fragment.source, '']),
    `installBridges([\n${installs.join(',\n')}\n]${fragment === undefined ? '' : ', appMembers(kit)'})`,
    '})()',
    ''
  ])
}

/** The kit's own runtime, read off disk. Exported so a test can compose a declaration without a recipe or an app directory. */
export async function bridgeRuntime (): Promise<ComposeInput['runtime']> {
  return {
    preamble: await readFile(join(RUNTIME, 'preamble.js'), 'utf8'),
    behaviours: await readFile(join(RUNTIME, 'behaviours.js'), 'utf8')
  }
}

/** The name the composed bridge is served under: the global it installs, so a devtools source list says which bridge it is, or the app's id when there are several. */
export function composedBridgeName (declaration: Declaration, appId: string): string {
  const names = Object.keys(declaration.globals)
  return `${names.length === 1 ? names[0] as string : appId}-bridge.js`
}

export interface ComposedBridge {
  readonly name: string
  readonly source: string
  readonly declaration: Declaration
}

/**
 * Reads a recipe's declaration and app file off disk and composes them. Used
 * by `prepare` to write the served bridge, and by the test harness so a port's
 * tests drive exactly the bytes the browser gets.
 */
export async function composeBridgeFor (recipe: Recipe, dirs: RecipeDirs): Promise<ComposedBridge> {
  const bridge = recipe.bridge
  if (bridge?.members === undefined) {
    throw new DeclarationError(`apps/${recipe.id}: no bridge.members in the recipe -- nothing to compose`)
  }
  const declarationPath = `apps/${recipe.id}/${bridge.members}`
  const text = await readFile(join(dirs.recipe, bridge.members), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DeclarationError(`${declarationPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const declaration = parseDeclaration(parsed, declarationPath)

  const appFragment = bridge.file === undefined
    ? undefined
    : { path: `apps/${recipe.id}/${bridge.file}`, source: await readFile(join(dirs.recipe, bridge.file), 'utf8') }

  return {
    name: composedBridgeName(declaration, recipe.id),
    source: composeBridge({ declaration, declarationPath, ...(appFragment === undefined ? {} : { appFragment }), runtime: await bridgeRuntime() }),
    declaration
  }
}
