import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { composeBridgeFor } from './bridge/compose.ts'
import { declareBundle, MANIFEST } from './declare.ts'
import { assertHostAgnostic } from './portable.ts'
import { isTracked, portsCommit, withSource } from './provenance.ts'
import { iconMimeType, iconTarget, isSite } from './recipe.ts'
import type { BridgeSpec, Recipe, RecipeDirs } from './recipe.ts'

// Turning a build into an Orivon app is additions and nothing else:
// the manifest, the one hint that makes the browser look for it, (when the
// app needs one) the bridge script, (unless turned off) the Orivon hint
// for visitors in other browsers, and last the tree's declaration -- the
// manifest's `assets` list and the bundle hash, generated from the finished
// files by declare.ts. The app's own output is copied verbatim -- see
// README.md's Design notes for why nothing else may change.

export interface PrepareContext {
  readonly recipe: Recipe
  readonly dirs: RecipeDirs
}

export interface PrepareOptions {
  /** The Orivon hint panel (src/orivon-hint/); on unless `--no-orivon-hint` turns it off. */
  readonly orivonHint?: boolean
  /** The commit written to the manifest's `source.portsCommit`. Absent means the checkout's own, when it is exactly at one; `null` means none. */
  readonly portsCommit?: string | null
}

/** The Orivon hint's files, copied as they are, and where they land in the served tree. */
const ORIVON_HINT_SOURCE = fileURLToPath(new URL('./orivon-hint/', import.meta.url))
const ORIVON_HINT_FILES = ['hint.js', 'hint.css', 'logo.png'] as const
const ORIVON_HINT_DIR = join('orivon', 'hint')

interface Hooks {
  readonly transformHtml?: (html: string, context: PrepareContext) => string | Promise<string>
}

/**
 * Every URL written into the document is relative to the entry document, so
 * the tree works wherever it is mounted -- at a host's root, or under an IPFS
 * path gateway's `/ipfs/<cid>/`. A root-absolute `/orivon/...` escapes that
 * prefix and 404s, and a bridge that 404s takes the app down with it. The
 * shell reads the hint through the DOM's resolved `.href`, so a relative one
 * reaches it already absolute.
 */
function fromEntry (entry: string, target: string): string {
  const path = relative(dirname(entry), target)
  return path.split(sep).join('/')
}

async function loadHooks (recipe: Recipe, dirs: RecipeDirs): Promise<Hooks> {
  if (recipe.hooks === undefined) return {}
  return await import(pathToFileURL(join(dirs.recipe, recipe.hooks)).href) as Hooks
}

/**
 * `<head>` is optional in HTML and its opening tag may carry attributes, so
 * neither tag can be matched as a literal string. `\\b` is what keeps
 * `HEAD_OPEN` off `<header>`: without it the bridge lands inside the first
 * `<header>` in the body, which runs AFTER the app's own bundle rather than
 * before it.
 */
const HEAD_OPEN = /<head\b[^>]*>/i
const HEAD_CLOSE = /<\/head\s*>/i

/**
 * Where a tag goes in a document with no `<head>` at all: after the doctype
 * and any `<html>`, never in front of them. A doctype that is not the first
 * thing in the document puts the page in quirks mode, which is a port whose
 * layout is quietly wrong with nothing logged anywhere.
 */
function afterDocumentStart (html: string, tag: string): string {
  const prelude = /^\s*(?:<!doctype[^>]*>)?\s*(?:<html\b[^>]*>)?/i.exec(html)
  const at = prelude === null ? 0 : prelude[0].length
  return at === 0 ? `${tag}\n${html}` : `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`
}

/**
 * The hint is the ONLY thing that makes a browser look for a manifest, so a
 * document without one never prompts and the app is just a web page. Before
 * `</head>` when there is one, else after the document's own opening: the
 * watcher scans the delivered document once and takes the first hint it finds.
 */
export function injectHint (html: string, href: string): string {
  if (html.includes('rel="orivon-manifest"')) return html
  const hint = `<link rel="orivon-manifest" href="${href}">`
  const close = HEAD_CLOSE.exec(html)
  if (close === null) return afterDocumentStart(html, hint)
  return `${html.slice(0, close.index)}  ${hint}\n${html.slice(close.index)}`
}

/** An icon link as a browser reads it: `rel` is a token list, so `shortcut icon` counts and `apple-touch-icon` does not. */
const ICON_LINK = /[ \t]*<link\b(?:[^>"']|"[^"]*"|'[^']*')*?(?<=\s)rel\s*=\s*(["'])\s*(?:shortcut\s+)?icon\s*\1(?:[^>"']|"[^"]*"|'[^']*')*>[ \t]*\n?/gi

/**
 * The tab icon. A port's window icon is set from Electron's main process, so
 * the built page names none, or names one the build never emitted (a root-
 * absolute `/favicon.ico` that also escapes a gateway's path prefix). The
 * recipe's icon replaces whatever the page names, so there is exactly one
 * `<link rel="icon">`, and it is where the first one was, else before
 * `</head>`.
 */
export function injectIcon (html: string, href: string, type: string): string {
  const link = `<link rel="icon" type="${type}" href="${href}">`
  const existing = [...html.matchAll(ICON_LINK)]
  const first = existing[0]
  if (first === undefined) {
    const close = HEAD_CLOSE.exec(html)
    if (close === null) return afterDocumentStart(html, link)
    return `${html.slice(0, close.index)}  ${link}\n${html.slice(close.index)}`
  }
  let seen = false
  return html.replace(ICON_LINK, (match) => {
    if (seen) return ''
    seen = true
    const lead = /^[ \t]*/.exec(match)?.[0] ?? ''
    return `${lead}${link}${match.endsWith('\n') ? '\n' : ''}`
  })
}

/**
 * FIRST script in `<head>`, classic and synchronous. Apps call bridge members
 * at module top level, so the bridge has to already exist when the app's own
 * bundle runs its first line -- a deferred or module script is too late, and
 * the failure is `undefined is not a function` inside somebody else's bundle.
 */
export function injectBridge (html: string, src: string): string {
  const tag = `<script src="${src}"></script>`
  if (html.includes(tag)) return html
  const open = HEAD_OPEN.exec(html)
  if (open === null) return afterDocumentStart(html, tag)
  const at = open.index + open[0].length
  return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`
}

/** The few fields of a recipe the hint tag is written from. */
type HintSource = Pick<Recipe, 'id' | 'name' | 'eth' | 'hint'>

function escapeAttribute (value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The hint script's tag, with the app's data as `data-*` attributes: the page's
 * Content Security Policy may forbid an inline script, and an attribute is not
 * one. A recipe without a `hint` field gets a tier 1 hint named after it.
 */
export function orivonHintTag (src: string, recipe: HintSource): string {
  const hint = recipe.hint
  const tier = hint?.tier ?? 1
  const data: Array<[string, string | undefined]> = [
    ['tier', String(tier)],
    ['app', recipe.id],
    ['name', hint?.name ?? recipe.name],
    ['eth', recipe.eth],
    ['official-url', hint?.officialUrl],
    ['text', hint?.text],
    ['notice', hint?.notice]
  ]
  const attributes = data.flatMap(([key, value]) => value === undefined ? [] : [` data-${key}="${escapeAttribute(value)}"`]).join('')
  return `<script src="${src}"${attributes}${tier === 2 ? '' : ' defer'}></script>`
}

/**
 * Tier 2 shows a landing instead of the app, so its script is the first thing
 * in `<head>` and synchronous: the app's own scripts, the bridge among them,
 * have not been reached when it stops the page. Tier 1 only shows a pill, so
 * it is deferred before `</head>` and delays nothing. Call it after
 * `injectBridge`, which would otherwise put the bridge first.
 */
export function injectOrivonHint (html: string, src: string, recipe: HintSource): string {
  if (html.includes(`<script src="${src}"`)) return html
  const tag = orivonHintTag(src, recipe)
  if (recipe.hint?.tier === 2) {
    const open = HEAD_OPEN.exec(html)
    if (open === null) return afterDocumentStart(html, tag)
    const at = open.index + open[0].length
    return `${html.slice(0, at)}\n    ${tag}${html.slice(at)}`
  }
  const close = HEAD_CLOSE.exec(html)
  if (close === null) return afterDocumentStart(html, tag)
  return `${html.slice(0, close.index)}  ${tag}\n${html.slice(close.index)}`
}

async function writeOrivonHint (out: string): Promise<void> {
  await mkdir(join(out, ORIVON_HINT_DIR), { recursive: true })
  for (const file of ORIVON_HINT_FILES) await cp(join(ORIVON_HINT_SOURCE, file), join(out, ORIVON_HINT_DIR, file))
}

/**
 * The served bridge: composed from the declaration when the recipe has one,
 * and otherwise the app's own file copied as it is. Composing is a build step
 * for the same reason injecting is -- whatever the browser gets was written
 * to disk before the server ever read it.
 */
async function writeBridge (bridge: BridgeSpec, recipe: Recipe, dirs: RecipeDirs, out: string): Promise<string> {
  if (bridge.members !== undefined) {
    const composed = await composeBridgeFor(recipe, dirs)
    await writeFile(join(out, 'orivon', composed.name), composed.source)
    return composed.name
  }
  if (bridge.file === undefined) throw new Error(`apps/${recipe.id}: bridge has neither members nor file`)
  const name = basename(bridge.file)
  await cp(join(dirs.recipe, bridge.file), join(out, 'orivon', name))
  return name
}

async function copyIcon (id: string, icon: string, dirs: RecipeDirs, out: string): Promise<void> {
  const from = join(dirs.source, icon)
  const target = join(out, iconTarget({ id, icon }))
  await mkdir(dirname(target), { recursive: true })
  try {
    await cp(from, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`apps/${id}: icon "${icon}" is not in the clone (${from}) -- the recipe's "icon" names a file the build needs`)
    throw error
  }
}

export async function prepareApp (recipe: Recipe, dirs: RecipeDirs, options: PrepareOptions = {}): Promise<string> {
  const built = isSite(recipe) ? join(dirs.recipe, recipe.site) : join(dirs.source, recipe.build.output)
  const out = dirs.static

  await rm(out, { recursive: true, force: true })
  await mkdir(dirname(out), { recursive: true })
  await cp(built, out, { recursive: true })

  const hooks = await loadHooks(recipe, dirs)
  let html = await readFile(join(out, recipe.entry), 'utf8')
  if (hooks.transformHtml !== undefined) html = await hooks.transformHtml(html, { recipe, dirs })
  if (!isSite(recipe) && recipe.icon !== undefined) {
    html = injectIcon(html, fromEntry(recipe.entry, iconTarget({ id: recipe.id, icon: recipe.icon })), iconMimeType(recipe.icon))
  }
  html = injectHint(html, fromEntry(recipe.entry, MANIFEST))

  if (recipe.bridge !== undefined) {
    await mkdir(join(out, 'orivon'), { recursive: true })
    const name = await writeBridge(recipe.bridge, recipe, dirs, out)
    html = injectBridge(html, fromEntry(recipe.entry, join('orivon', name)))
  }
  if (options.orivonHint ?? true) {
    await writeOrivonHint(out)
    html = injectOrivonHint(html, fromEntry(recipe.entry, join(ORIVON_HINT_DIR, 'hint.js')), recipe)
  }
  await writeFile(join(out, recipe.entry), html)

  await mkdir(join(out, dirname(MANIFEST)), { recursive: true })
  const manifest = await readFile(join(dirs.recipe, recipe.manifest), 'utf8')
  const commit = options.portsCommit === undefined ? (isTracked(dirs.recipe) ? await portsCommit() : undefined) : options.portsCommit ?? undefined
  await writeFile(join(out, MANIFEST), withSource(manifest, commit))

  if (!isSite(recipe) && recipe.icon !== undefined) await copyIcon(recipe.id, recipe.icon, dirs, out)

  for (const extra of recipe.extraFiles) {
    const target = join(out, extra.to)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(dirs.source, extra.from), target, { recursive: true })
  }

  // Over everything: what leaves here has to be servable by any static host,
  // not only by the one in this repository.
  await assertHostAgnostic(out, recipe.id)
  // Last, because it hashes the tree: any write after it would go undeclared.
  await declareBundle(out, { check: false, label: recipe.id })
  return out
}
