import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APPS_DIR, recipeDir } from './paths.ts'
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
  return ids.sort()
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
