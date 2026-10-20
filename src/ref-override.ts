import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isSite } from './recipe.ts'
import type { PortRecipe, Recipe } from './recipe.ts'

const execFileAsync = promisify(execFile)

const FULL_SHA = /^[0-9a-f]{40}$/i

/** What `git ls-remote <repo> <patterns...>` prints, one `sha<TAB>refname` per line. */
export type LsRemote = (repo: string, patterns: readonly string[]) => Promise<string>

async function gitLsRemote (repo: string, patterns: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['ls-remote', repo, ...patterns], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/**
 * The commit a `--ref` names: a full sha as it is, or a tag, peeled to the
 * commit it points at. A branch is refused for the reason the recipe refuses
 * one: a build of "whatever the branch is today" cannot be repeated.
 */
export async function resolveRef (repo: string, ref: string, lsRemote: LsRemote = gitLsRemote): Promise<string> {
  if (FULL_SHA.test(ref)) return ref.toLowerCase()
  if (ref === '' || ref.startsWith('-') || /\s/.test(ref)) throw new Error(`--ref "${ref}" is neither a full 40-character commit sha nor a tag name`)
  const listing = await lsRemote(repo, [`refs/tags/${ref}`, `refs/tags/${ref}^{}`])
  let tagged: string | undefined
  let peeled: string | undefined
  for (const line of listing.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/)
    if (sha === undefined || name === undefined || !FULL_SHA.test(sha)) continue
    if (name === `refs/tags/${ref}^{}`) peeled = sha
    else if (name === `refs/tags/${ref}`) tagged = sha
  }
  const commit = peeled ?? tagged
  if (commit === undefined) {
    throw new Error(`--ref "${ref}": ${repo} has no such tag, and it is not a full 40-character commit sha (a branch name would not be repeatable)`)
  }
  return commit.toLowerCase()
}

/**
 * The recipe with `upstream.ref` replaced, so `fetch`, `build` and `run` build
 * a new upstream version before the recipe is edited. Everything downstream
 * reads the ref from the recipe, so the build state and the stale-build
 * notices follow the override with no further change.
 */
export async function withRefOverride (recipe: Recipe, ref: string, lsRemote?: LsRemote): Promise<PortRecipe> {
  if (isSite(recipe)) throw new Error(`[${recipe.id}] is written here, so there is no upstream ref to override`)
  const commit = await resolveRef(recipe.upstream.repo, ref, lsRemote)
  return { ...recipe, upstream: { ...recipe.upstream, ref: commit } }
}
