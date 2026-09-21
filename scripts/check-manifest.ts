// Each app's orivon.json is what the consent dialog renders. A manifest that
// does not parse, or that omits a field, is a dialog that cannot be shown --
// and consent is read before any of the app's code runs, so the failure is
// the app not starting at all.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAllRecipes } from '../src/apps.ts'
import { recipeDir } from '../src/paths.ts'
import { report } from './lib.ts'

const REQUIRED = ['orivonApiVersion', 'id', 'name', 'version', 'entry', 'capabilities']

const problems: string[] = []

for (const recipe of await loadAllRecipes()) {
  const path = join(recipeDir(recipe.id), recipe.manifest)
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    problems.push(`apps/${recipe.id}/${recipe.manifest}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  for (const field of REQUIRED) {
    if (manifest[field] === undefined) problems.push(`apps/${recipe.id}/${recipe.manifest}: "${field}" is required`)
  }
  if (manifest['entry'] !== recipe.entry) {
    problems.push(`apps/${recipe.id}: manifest entry "${String(manifest['entry'])}" and recipe entry "${recipe.entry}" disagree -- the browser loads the manifest's, the build wrapper produces the recipe's`)
  }
}

report('check:manifest', problems)
