import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireLock } from './lock.ts'
import { buildDir, buildRoot } from './paths.ts'

// The folder every build runs in (paths.ts `buildRoot`) is shared by all the
// checkouts on a machine, so a build holds its app's folder alone, and a
// checkout re-uses what is there only when it is the build it made.

const BUILT_FILE = '.built-at'

/**
 * Creates `root` private to this user and returns it, or throws when it is not
 * one. The clone inside is cleaned with `git clean -ffdx`, and `/tmp` is a place
 * another user can plant a link: a root that is a link, or is owned by somebody
 * else, is never built in.
 */
export async function claimBuildRoot (root: string = buildRoot(), uid: number | undefined = process.getuid?.()): Promise<string> {
  // A name taken by something that is not a folder is refused below, with a better message than mkdir's.
  await mkdir(root, { recursive: true, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(root)
  if (!info.isDirectory()) {
    throw new Error(`${root} is ${info.isSymbolicLink() ? 'a link' : 'not a folder'}, and builds run inside it -- remove it, or name another folder with ORIVON_PORTS_BUILD_DIR`)
  }
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${root} belongs to another user (uid ${String(info.uid)}), and builds run inside it -- name a folder of your own with ORIVON_PORTS_BUILD_DIR`)
  }
  return root
}

/** Holds the app's build folder until released; another run in it, from any checkout, is refused by name. */
export async function lockBuildDir (id: string): Promise<() => Promise<void>> {
  await claimBuildRoot()
  return acquireLock(buildDir(id), id)
}

/** Records, beside the clone, which build it holds: `AppState.builtAt` of the checkout that made it. */
export async function markBuilt (folder: string, builtAt: string): Promise<void> {
  await writeFile(join(folder, BUILT_FILE), builtAt)
}

/**
 * Whether the clone in `folder` still holds the build a checkout recorded as `builtAt`. Another checkout
 * (or `verify`) builds in the same folder, so what the clone holds may be a build of another ref or recipe.
 */
export async function builtHere (folder: string, builtAt: string | undefined): Promise<boolean> {
  if (builtAt === undefined) return false
  return await readFile(join(folder, BUILT_FILE), 'utf8').catch(() => undefined) === builtAt
}
