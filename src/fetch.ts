import { access, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname } from 'node:path'
import type { Recipe, RecipeDirs } from './recipe.ts'
import { run } from './exec.ts'
import { writeState } from './state.ts'

const execFileAsync = promisify(execFile)

async function head (dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir })
    return stdout.trim()
  } catch {
    return undefined
  }
}

async function exists (path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

/**
 * Puts the app's own source at exactly `upstream.ref` in `out/<app>/source`,
 * and proves it did. The proof is the point: a checkout that silently landed
 * somewhere else produces a build nobody can reproduce, and the difference is
 * invisible until the port breaks against a release nobody chose.
 */
export async function fetchApp (recipe: Recipe, dirs: RecipeDirs, options: { force?: boolean } = {}): Promise<void> {
  const dir = dirs.source
  const { ref, repo } = recipe.upstream

  if (options.force !== true && await head(dir) === ref) {
    process.stdout.write(`[${recipe.id}] source already at ${ref.slice(0, 8)}\n`)
    await writeState(dirname(dir), { fetchedRef: ref })
    return
  }

  if (!await exists(dir)) {
    await mkdir(dir, { recursive: true })
    await run(`git init -q && git remote add origin ${repo}`, dir, recipe.id)
  }

  // A pinned sha first, which is one commit instead of a history. Not every
  // host serves a sha directly (it needs uploadpack.allowReachableSHA1InWant,
  // which GitHub has and a self-hosted mirror may not), so a full fetch is
  // the fallback rather than the default.
  try {
    await run(`git fetch --depth 1 origin ${ref}`, dir, recipe.id)
  } catch {
    process.stdout.write(`[${recipe.id}] shallow fetch of ${ref.slice(0, 8)} refused -- fetching the full history\n`)
    await run('git fetch --tags origin', dir, recipe.id)
  }
  await run(`git checkout -q --detach ${ref}`, dir, recipe.id)

  const landed = await head(dir)
  if (landed !== ref) {
    throw new Error(`[${recipe.id}] checkout landed on ${String(landed)}, not the pinned ${ref}`)
  }

  await writeState(dirname(dir), { fetchedRef: ref })
  process.stdout.write(`[${recipe.id}] source at ${ref.slice(0, 8)}\n`)
}
