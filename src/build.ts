import { access, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PortRecipe, RecipeDirs } from './recipe.ts'
import { expandTokens } from './recipe.ts'
import { run } from './exec.ts'
import { recipeDigest, writeState } from './state.ts'

/**
 * Where the build writes, which `buildApp` deletes before every build. Only a
 * directory strictly inside the source tree qualifies: an empty, `.`, `..`,
 * absolute or climbing `build.output` would otherwise delete the source, its
 * parent, or anything the process can reach.
 */
export function outputDirectory (source: string, output: string, id: string): string {
  const root = resolve(source)
  const target = resolve(root, output)
  const inside = relative(root, target)
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`[${id}] build.output "${output}" must be a directory inside the source tree, not the tree itself or anything outside it`)
  }
  return target
}

/**
 * Runs the app's OWN install and build, in its own tree, through its own
 * toolchain. Nothing here forks or patches the app: a recipe that needs the
 * build to behave differently does it with a wrapper config of its own that
 * requires upstream's, which is why `build.command` can name `{recipe}`.
 */
export async function buildApp (recipe: PortRecipe, dirs: RecipeDirs): Promise<void> {
  const source = dirs.source
  const output = outputDirectory(source, recipe.build.output, recipe.id)

  // The output directory is what gets published, so a file an earlier build
  // left there would be published too. Every build starts it empty.
  await rm(output, { recursive: true, force: true })

  if (recipe.install !== undefined) await run(expandTokens(recipe.install, dirs), source, recipe.id)
  await run(expandTokens(recipe.build.command, dirs), source, recipe.id)
  for (const extra of recipe.build.also ?? []) await run(expandTokens(extra, dirs), source, recipe.id)

  try {
    await access(join(output, recipe.entry))
  } catch {
    throw new Error(
      `[${recipe.id}] the build reported success but produced no ${recipe.entry}\n` +
      `  expected: ${join(output, recipe.entry)}\n` +
      '  build.output in the recipe is relative to the source root -- check it against what the build actually wrote'
    )
  }

  await writeState(dirname(source), {
    builtFromRef: recipe.upstream.ref,
    builtAt: new Date().toISOString(),
    ...(recipe.upstream.library === true ? { builtFromRecipe: await recipeDigest(dirs.recipe) } : {})
  })
}
