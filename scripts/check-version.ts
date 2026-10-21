// Each published app keeps a record of the version it was last published at
// (apps/<app>/published.json, written by `orivon-port release`). The browser
// offers an update only for a higher version, so a manifest that falls behind
// its record, or a record that does not parse, is an app whose next publish
// would not reach anyone. Needs no build.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readRecord, versionProblem } from '../src/release.ts'
import { recipeDir } from '../src/paths.ts'
import { recipesOrReport, report } from './lib.ts'

const problems: string[] = []

for (const recipe of await recipesOrReport('check:version')) {
  const dir = recipeDir(recipe.id)
  let record
  try {
    record = await readRecord(dir)
  } catch (error) {
    problems.push(`apps/${recipe.id}/published.json: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  if (record === undefined) continue
  const manifest = JSON.parse(await readFile(join(dir, recipe.manifest), 'utf8')) as { version?: unknown }
  const problem = versionProblem(recipe.id, record, manifest.version)
  if (problem !== undefined) problems.push(problem)
}

report('check:version', problems)
