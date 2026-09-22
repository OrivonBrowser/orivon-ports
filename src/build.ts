import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { dirname } from 'node:path'
import type { PortRecipe, RecipeDirs } from './recipe.ts'
import { expandTokens } from './recipe.ts'
import { run } from './exec.ts'
import { writeState } from './state.ts'

/**
 * Runs the app's OWN install and build, in its own tree, through its own
 * toolchain. Nothing here forks or patches the app: a recipe that needs the
 * build to behave differently does it with a wrapper config of its own that
 * requires upstream's, which is why `build.command` can name `{recipe}`.
 */
export async function buildApp (recipe: PortRecipe, dirs: RecipeDirs): Promise<void> {
  const source = dirs.source

  if (recipe.install !== undefined) await run(expandTokens(recipe.install, dirs), source, recipe.id)
  await run(expandTokens(recipe.build.command, dirs), source, recipe.id)
  for (const extra of recipe.build.also ?? []) await run(expandTokens(extra, dirs), source, recipe.id)

  const output = join(source, recipe.build.output)
  try {
    await access(join(output, recipe.entry))
  } catch {
    throw new Error(
      `[${recipe.id}] the build reported success but produced no ${recipe.entry}\n` +
      `  expected: ${join(output, recipe.entry)}\n` +
      '  build.output in the recipe is relative to the source root -- check it against what the build actually wrote'
    )
  }

  await writeState(dirname(source), { builtFromRef: recipe.upstream.ref, builtAt: new Date().toISOString() })
}
