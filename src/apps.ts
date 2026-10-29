import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APPS_DIR, extraApps, recipeDir } from './paths.ts'
import { parseRecipe, RecipeError } from './recipe.ts'
import type { Recipe } from './recipe.ts'

export const RECIPE_FILE = 'recipe.json'

export async function listAppIds (): Promise<string[]> {
  const entries = await readdir(APPS_DIR, { withFileTypes: true }).catch(() => [])
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await readFile(join(APPS_DIR, entry.name, RECIPE_FILE))
      ids.push(entry.name)
    } catch { /* a directory with no recipe is not an app */ }
  }
  return [...ids, ...extraApps().keys()].sort()
}

export async function loadRecipe (id: string): Promise<Recipe> {
  const path = join(recipeDir(id), RECIPE_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    const known = await listAppIds()
    const suffix = known.length === 0 ? 'no apps exist yet -- `orivon-port new <id>` makes one' : `known apps: ${known.join(', ')}`
    throw new RecipeError(`no recipe at apps/${id}/${RECIPE_FILE} -- ${suffix}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new RecipeError(`apps/${id}/${RECIPE_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parseRecipe(parsed, `apps/${id}/${RECIPE_FILE}`)
}

export async function loadAllRecipes (): Promise<Recipe[]> {
  return Promise.all((await listAppIds()).map(loadRecipe))
}

export interface AppManifestId {
  /** The app's id: its directory name, and the recipe's `id`. */
  readonly id: string
  readonly dir: string
  /** The `id` in the app's manifest, which a built tree and a published one name themselves by. Never the recipe's. */
  readonly manifestId: string
}

/**
 * Every app that has a readable recipe and a manifest with an `id`. An app whose files do not parse
 * is left out: `check:manifest` reports it, and one broken app must not stop another's check.
 */
export async function manifestIdsOfApps (): Promise<AppManifestId[]> {
  const found: AppManifestId[] = []
  for (const id of await listAppIds()) {
    const dir = recipeDir(id)
    try {
      const recipe = await loadRecipe(id)
      const manifest = JSON.parse(await readFile(join(dir, recipe.manifest), 'utf8')) as { id?: unknown }
      if (typeof manifest.id === 'string') found.push({ id, dir, manifestId: manifest.id })
    } catch { /* reported by check:manifest */ }
  }
  return found
}

/**
 * The app whose manifest carries `manifestId`, or undefined. A built tree says which app it is by its
 * manifest's id, and ports name their apps by the recipe's (`eth.decentrawiki.editor` is `decentrawiki`),
 * so a lookup by the first against the second finds nothing.
 */
export async function appOfManifestId (manifestId: string): Promise<AppManifestId | undefined> {
  const apps = (await manifestIdsOfApps()).filter((app) => app.manifestId === manifestId)
  if (apps.length > 1) throw new Error(`the manifests of ${apps.map((app) => app.id).join(' and ')} all say id "${manifestId}" -- each app's manifest has an id of its own`)
  return apps[0]
}
