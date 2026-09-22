// Every app declares the licence of the code it builds, and says in prose
// what does and does not cross into this repository.
//
// The allowlist is not a legal opinion. It is a stop sign: a licence that is
// not on it needs a person to decide, and adding it to this list is that
// decision being recorded.
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recipeDir } from '../src/paths.ts'
import { isSite } from '../src/recipe.ts'
import { recipesOrReport, report } from './lib.ts'

export const ALLOWED_LICENCES = [
  'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'GPL-3.0-only', 'GPL-3.0-or-later',
  'GPL-2.0-only', 'GPL-2.0-or-later',
  'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'MPL-2.0', 'Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense', 'CC0-1.0'
]

const problems: string[] = []

for (const recipe of await recipesOrReport('check:licences')) {
  // A site is this repository's own code, under this repository's licence.
  if (isSite(recipe)) continue
  if (!ALLOWED_LICENCES.includes(recipe.upstream.licence)) {
    problems.push(`apps/${recipe.id}: upstream.licence "${recipe.upstream.licence}" is not in ALLOWED_LICENCES -- a person decides whether this app can be ported, then adds it to scripts/check-licences.ts`)
  }
  const upstreamDoc = join(recipeDir(recipe.id), 'UPSTREAM.md')
  if (!await access(upstreamDoc).then(() => true).catch(() => false)) {
    problems.push(`apps/${recipe.id}: no UPSTREAM.md -- every port states its pin, its licence, and what never crosses into this repository`)
    continue
  }
  const text = await readFile(upstreamDoc, 'utf8')
  if (!text.includes(recipe.upstream.licence)) {
    problems.push(`apps/${recipe.id}/UPSTREAM.md does not name ${recipe.upstream.licence}, which recipe.json declares`)
  }
  if (!text.includes(recipe.upstream.ref)) {
    problems.push(`apps/${recipe.id}/UPSTREAM.md does not name the pinned commit ${recipe.upstream.ref.slice(0, 8)} that recipe.json declares`)
  }
}

report('check:licences', problems)
