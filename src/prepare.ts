import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeBridgeFor } from './bridge/compose.ts'
import { assertHostAgnostic } from './portable.ts'
import type { BridgeSpec, Recipe, RecipeDirs } from './recipe.ts'

// Turning a build into an Orivon app is three additions and nothing else:
// the manifest, the one hint that makes the browser look for it, and (when
// the app needs one) the bridge script. The app's own output is copied
// verbatim -- see README.md's Design notes for why nothing else may change.

export interface PrepareContext {
  readonly recipe: Recipe
  readonly dirs: RecipeDirs
}

interface Hooks {
  readonly transformHtml?: (html: string, context: PrepareContext) => string | Promise<string>
}

const MANIFEST = join('.well-known', 'orivon.json')

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

export async function prepareApp (recipe: Recipe, dirs: RecipeDirs): Promise<string> {
  const built = join(dirs.source, recipe.build.output)
  const out = dirs.static

  await rm(out, { recursive: true, force: true })
  await mkdir(dirname(out), { recursive: true })
  await cp(built, out, { recursive: true })

  const hooks = await loadHooks(recipe, dirs)
  let html = await readFile(join(out, recipe.entry), 'utf8')
  if (hooks.transformHtml !== undefined) html = await hooks.transformHtml(html, { recipe, dirs })
  html = injectHint(html, fromEntry(recipe.entry, MANIFEST))

  if (recipe.bridge !== undefined) {
    await mkdir(join(out, 'orivon'), { recursive: true })
    const name = await writeBridge(recipe.bridge, recipe, dirs, out)
    html = injectBridge(html, fromEntry(recipe.entry, join('orivon', name)))
  }
  await writeFile(join(out, recipe.entry), html)

  await mkdir(join(out, dirname(MANIFEST)), { recursive: true })
  const manifest = await readFile(join(dirs.recipe, recipe.manifest), 'utf8')
  await writeFile(join(out, MANIFEST), manifest)

  for (const extra of recipe.extraFiles) {
    const target = join(out, extra.to)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(dirs.source, extra.from), target, { recursive: true })
  }

  // Last, over everything: what leaves here has to be servable by any static
  // host, not only by the one in this repository.
  await assertHostAgnostic(out, recipe.id)
  return out
}
