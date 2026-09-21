import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Recipe, RecipeDirs } from './recipe.ts'

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

const HINT = '<link rel="orivon-manifest" href="/.well-known/orivon.json">'

async function loadHooks (recipe: Recipe, dirs: RecipeDirs): Promise<Hooks> {
  if (recipe.hooks === undefined) return {}
  return await import(pathToFileURL(join(dirs.recipe, recipe.hooks)).href) as Hooks
}

/**
 * The hint is the ONLY thing that makes a browser look for a manifest, so a
 * document without one never prompts and the app is just a web page. Before
 * `</head>` when there is one, else at the very top: the watcher scans the
 * delivered document once and takes the first hint it finds.
 */
export function injectHint (html: string): string {
  if (html.includes('rel="orivon-manifest"')) return html
  return html.includes('</head>') ? html.replace('</head>', `  ${HINT}\n</head>`) : `${HINT}\n${html}`
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
  return html.includes('<head>') ? html.replace('<head>', `<head>\n    ${tag}`) : `${tag}\n${html}`
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
  html = injectHint(html)

  if (recipe.bridge !== undefined) {
    const name = basename(recipe.bridge.file)
    await mkdir(join(out, 'orivon'), { recursive: true })
    await cp(join(dirs.recipe, recipe.bridge.file), join(out, 'orivon', name))
    html = injectBridge(html, `/orivon/${name}`)
  }
  await writeFile(join(out, recipe.entry), html)

  await mkdir(join(out, '.well-known'), { recursive: true })
  const manifest = await readFile(join(dirs.recipe, recipe.manifest), 'utf8')
  await writeFile(join(out, '.well-known', 'orivon.json'), manifest)

  for (const extra of recipe.extraFiles) {
    const target = join(out, extra.to)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(dirs.source, extra.from), target, { recursive: true })
  }

  return out
}
