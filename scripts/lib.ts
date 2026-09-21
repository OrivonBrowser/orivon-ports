import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO_ROOT } from '../src/paths.ts'
import { loadAllRecipes } from '../src/apps.ts'
import type { Recipe } from '../src/recipe.ts'

export { REPO_ROOT }

const SKIP = /^(?:node_modules|\.git|out|dist|coverage)$/

export async function walk (dir: string, match: RegExp): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP.test(entry.name)) found.push(...await walk(path, match))
    } else if (match.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

export function report (name: string, problems: readonly string[]): void {
  if (problems.length === 0) {
    process.stdout.write(`${name}: ok\n`)
    return
  }
  process.stderr.write(`${name}: ${String(problems.length)} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}\n`)
  process.exitCode = 1
}

/**
 * Loads every recipe, turning a malformed one into this gate's own clean
 * report. Without it a bad recipe reaches the top level as an uncaught
 * RecipeError and prints a stack trace, which buries the one line that says
 * which field is wrong.
 */
export async function recipesOrReport (name: string): Promise<Recipe[]> {
  try {
    return await loadAllRecipes()
  } catch (error) {
    report(name, [error instanceof Error ? error.message : String(error)])
    process.exit(1)
  }
}
