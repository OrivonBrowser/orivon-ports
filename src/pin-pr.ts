import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Finding } from './upstream-release.ts'

const execFileAsync = promisify(execFile)

type Update = Extract<Finding, { kind: 'update' }>

/** The recipe text with `upstream.ref` moved. Exactly one pinned ref must be there to replace, or nothing is written. */
export function movePin (recipeText: string, oldRef: string, newRef: string): string {
  const field = `"ref": "${oldRef}"`
  const first = recipeText.indexOf(field)
  if (first === -1 || recipeText.indexOf(field, first + 1) !== -1) {
    throw new Error(`the recipe does not hold the pinned ref ${oldRef} exactly once`)
  }
  return recipeText.replace(field, `"ref": "${newRef}"`)
}

/** A branch name git accepts, from the app and the release tag. */
export function pinBranch (app: string, tag: string): string {
  return `pin/${app}-${tag.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}`
}

export const pinPrTitle = (update: Update): string => `Move ${update.name} to ${update.tag}`

export function pinPrBody (update: Update): string {
  return [
    `Moves the pin of \`${update.app}\` to the upstream release [${update.tag}](${update.url}) (commit \`${update.commit}\`).`,
    '',
    'This changes `upstream.ref` and nothing else. Before it is ready:',
    '',
    '- [ ] `UPSTREAM.md` names the new commit and says which release it is',
    '- [ ] `orivon.json`\'s version is the new upstream version with build number 1',
    '- [ ] the member declaration is re-measured (`node src/cli.ts recon <clone> --emit ' + update.app + '`)',
    '- [ ] the app builds from an empty `out/` and the sweep in `verify.md` passes',
    '',
    'The steps are the "A new upstream release" job in `.claude/skills/orivon-porting/maintain.md`.'
  ].join('\n')
}

export interface Runner {
  run: (command: string, args: readonly string[]) => Promise<{ code: number, stdout: string }>
}

export const processRunner: Runner = {
  async run (command, args) {
    try {
      return { code: 0, stdout: (await execFileAsync(command, [...args])).stdout }
    } catch (error) {
      const failure = error as { code?: unknown, stdout?: unknown }
      if (typeof failure.code === 'number') return { code: failure.code, stdout: String(failure.stdout ?? '') }
      throw error
    }
  }
}

async function must (runner: Runner, command: string, args: readonly string[]): Promise<string> {
  const result = await runner.run(command, args)
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit ${String(result.code)})`)
  return result.stdout
}

/**
 * One draft pull request per update, from a branch of its own. A branch that
 * already exists means an earlier run opened it, so that update is skipped.
 * Runs from a checkout of the base branch, which it leaves checked out.
 */
export async function openPinPrs (updates: readonly Update[], root: string, base: string, runner: Runner = processRunner): Promise<string[]> {
  const opened: string[] = []
  for (const update of updates) {
    const branch = pinBranch(update.app, update.tag)
    if ((await runner.run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch])).code === 0) continue
    const file = join(root, 'apps', update.app, 'recipe.json')
    try {
      await writeFile(file, movePin(await readFile(file, 'utf8'), update.pinned, update.commit))
      await must(runner, 'git', ['switch', '-c', branch])
      await must(runner, 'git', ['add', `apps/${update.app}/recipe.json`])
      await must(runner, 'git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-q', '-m', pinPrTitle(update)])
      await must(runner, 'git', ['push', 'origin', branch])
      await must(runner, 'gh', ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', pinPrTitle(update), '--body', pinPrBody(update)])
      opened.push(branch)
    } finally {
      await runner.run('git', ['switch', '-q', '--discard-changes', base])
    }
  }
  return opened
}
