import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { RecipeDirs } from './recipe.ts'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const APPS_DIR = join(REPO_ROOT, 'apps')
export const OUT_DIR = join(REPO_ROOT, 'out')

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Every directory below is built by joining an app id onto a path we own, and
 * an id reaches here from a recipe file and from the command line. `parseRecipe`
 * already rejects an unsafe one; a command-line id has met nothing yet.
 */
function checked (id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`"${id}" is not an app id -- lowercase letters, digits and dashes only`)
  return id
}

export function recipeDir (id: string): string {
  return join(APPS_DIR, checked(id))
}

export function outAppDir (id: string): string {
  return join(OUT_DIR, checked(id))
}

export function sourceDir (id: string): string {
  return join(outAppDir(id), 'source')
}

export function staticDir (id: string): string {
  return join(outAppDir(id), 'static')
}

export function dirsFor (id: string): RecipeDirs {
  return { recipe: recipeDir(id), source: sourceDir(id), static: staticDir(id) }
}
