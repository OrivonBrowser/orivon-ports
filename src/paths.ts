import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { delimiter, join, posix, resolve, win32 } from 'node:path'
import type { RecipeDirs } from './recipe.ts'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const APPS_DIR = join(REPO_ROOT, 'apps')
export const OUT_DIR = join(REPO_ROOT, 'out')

/** Directories searched for apps that live outside this repository, separated as `PATH` is. */
export const EXTRA_APPS_ENV = 'ORIVON_PORTS_EXTRA_APPS'

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

function hasRecipe (dir: string): boolean {
  return existsSync(join(dir, 'recipe.json'))
}

/**
 * Apps kept outside `apps/`, by id. An entry of `ORIVON_PORTS_EXTRA_APPS` is either one app
 * (a directory holding a `recipe.json`, named by that recipe's `id`) or a directory of apps
 * laid out as `apps/` is. The environment is read on every call, so a test can set it.
 */
export function extraApps (env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const found = new Map<string, string>()
  const add = (id: string, dir: string): void => {
    if (found.has(id) || hasRecipe(join(APPS_DIR, checked(id)))) {
      throw new Error(`app "${id}" is found twice (${EXTRA_APPS_ENV} and apps/) -- ids must be unique`)
    }
    found.set(id, dir)
  }
  for (const entry of (env[EXTRA_APPS_ENV] ?? '').split(delimiter).filter((part) => part !== '')) {
    const dir = resolve(entry)
    if (hasRecipe(dir)) {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, 'recipe.json'), 'utf8'))
      const id = (parsed as { id?: unknown } | null)?.id
      if (typeof id !== 'string') throw new Error(`${join(dir, 'recipe.json')} has no "id"`)
      add(id, dir)
      continue
    }
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory() && hasRecipe(join(dir, child.name))) add(child.name, join(dir, child.name))
    }
  }
  return found
}

export function recipeDir (id: string): string {
  return extraApps().get(checked(id)) ?? join(APPS_DIR, id)
}

export function outAppDir (id: string): string {
  return join(OUT_DIR, checked(id))
}

/** Names the folder that holds every build, in place of the one `buildRoot` picks. */
export const BUILD_DIR_ENV = 'ORIVON_PORTS_BUILD_DIR'

/**
 * The one folder per machine upstream is cloned and built in, whichever checkout runs the build. A tool writes the
 * absolute path of what it builds into its output (source maps, module names), so a build under `out/` makes other
 * bytes in every folder a checkout sits in; this path is the same on a laptop, a server and the attested runner.
 * It is not `os.tmpdir()`, which differs by user and by `TMPDIR`. On Windows it is a short path on the system drive,
 * which also keeps a deep `node_modules` inside the path-length limit. `ORIVON_PORTS_BUILD_DIR` moves it (a small
 * `/tmp`, a disk with more room); a tree then differs from one built elsewhere only where the app writes its paths.
 */
export function buildRoot (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const given = env[BUILD_DIR_ENV]
  if (given !== undefined && given !== '') return resolve(given)
  return platform === 'win32' ? win32.join(env['SystemDrive'] ?? 'C:', '\\', 'orivon-ports-build') : posix.join('/tmp', 'orivon-ports-build')
}

/** What one app owns in `buildRoot`: its clone, and the tools a recipe installs beside it (`../pnpm`, `../esbuild`). */
export function buildDir (id: string): string {
  return join(buildRoot(), checked(id))
}

export function sourceDir (id: string): string {
  return join(buildDir(id), 'source')
}

export function staticDir (id: string): string {
  return join(outAppDir(id), 'static')
}

export function dirsFor (id: string): RecipeDirs {
  return { recipe: recipeDir(id), source: sourceDir(id), static: staticDir(id) }
}
