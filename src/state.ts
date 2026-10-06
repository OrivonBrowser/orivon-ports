import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * What `out/<app>/` currently holds, so `run` can skip a clone and a build
 * that would produce what is already there. It records the ref a build was
 * made FROM, not just that one happened: bumping `upstream.ref` in the recipe
 * has to invalidate the build, and a timestamp alone cannot tell you that.
 */
export interface AppState {
  readonly fetchedRef?: string
  readonly builtFromRef?: string
  readonly builtAt?: string
  /** Whether the served tree carries the Orivon hint. Absent means unknown, and an unknown tree is prepared again. */
  readonly orivonHint?: boolean
  /** `recipeDigest` of the recipe directory the served tree was prepared from. Absent means unknown, and an unknown tree is prepared again. */
  readonly preparedFrom?: string
}

const STATE_FILE = '.orivon-state.json'

/** One hash over every file in a recipe directory, paths included, so any edit there tells a prepared tree apart. */
export async function recipeDigest (dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file.slice(dir.length)}\0`)
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function readState (dir: string): Promise<AppState> {
  try {
    return JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')) as AppState
  } catch {
    // A missing, unreadable or corrupt state file means the same thing to
    // every caller: nothing here can be trusted, so do the work again.
    return {}
  }
}

export async function writeState (dir: string, patch: AppState): Promise<void> {
  await mkdir(dir, { recursive: true })
  const next = { ...await readState(dir), ...patch }
  await writeFile(join(dir, STATE_FILE), `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * The warning `serve` prints when `out/<app>/` was built from a commit other
 * than the recipe's pin, or undefined when it is current or never built.
 */
export function staleBuildNotice (id: string, state: AppState, pinnedRef: string): string | undefined {
  if (state.builtFromRef === undefined || state.builtFromRef === pinnedRef) return undefined
  return `[${id}] serving a build from ${state.builtFromRef.slice(0, 8)}, but the recipe pins ${pinnedRef.slice(0, 8)} -- run \`orivon-port run ${id}\` to rebuild`
}

/** The warning `serve` prints when `out/<app>/` was prepared from another recipe directory (`digest` is the current one), or undefined when it matches. */
export function stalePrepareNotice (id: string, state: AppState, digest: string): string | undefined {
  if (state.preparedFrom === digest) return undefined
  return `[${id}] serving a tree prepared before apps/${id}/ last changed (its manifest may be out of date) -- run \`orivon-port run ${id}\` to prepare it again`
}
