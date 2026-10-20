import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { APPS_DIR, REPO_ROOT } from './paths.ts'

const execFileAsync = promisify(execFile)

const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * The commit of this repository the working tree is exactly at, or undefined:
 * not a git checkout, or files changed since the commit. A tree that is not
 * a commit must not claim one, so a published manifest's `source.portsCommit`
 * always names a commit `orivon-port verify` can rebuild from.
 */
export async function portsCommit (root: string = REPO_ROOT): Promise<string | undefined> {
  try {
    const head = (await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    if (!FULL_SHA.test(head)) return undefined
    const changed = (await execFileAsync('git', ['-C', root, 'status', '--porcelain'])).stdout.trim()
    return changed === '' ? head : undefined
  } catch {
    return undefined
  }
}

/** Whether an app's directory is this repository's own `apps/` entry, which the commit describes; an app kept elsewhere is not in it. */
export function isTracked (recipeDirectory: string): boolean {
  const normal = (path: string): string => path.replaceAll('\\', '/')
  return normal(recipeDirectory).startsWith(`${normal(APPS_DIR)}/`)
}

/**
 * The manifest with `source.portsCommit` added after its other keys, which the
 * client ignores but a person (or `orivon-port verify`) reads to know which
 * commit built the tree. Without a commit, or when the text is not a JSON
 * object (the declaration step names that fault), the text is returned as it is.
 */
export function withSource (manifestText: string, commit: string | undefined): string {
  if (commit === undefined) return manifestText
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestText)
  } catch {
    return manifestText
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return manifestText
  const { source: _replaced, ...rest } = parsed as Record<string, unknown>
  return `${JSON.stringify({ ...rest, source: { portsCommit: commit } }, null, 2)}\n`
}
