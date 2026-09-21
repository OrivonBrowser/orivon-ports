import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
}

const STATE_FILE = '.orivon-state.json'

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
