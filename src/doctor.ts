import { exec, execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadAllRecipes } from './apps.ts'
import { HOST } from './serve.ts'
import { recipeShell, SHELL_ENV } from './shell.ts'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

export type Level = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly level: Level
  readonly what: string
  readonly detail: string
}

/** Through a shell, because on Windows `npm` and its siblings are `.cmd` shims execFile cannot start. */
async function version (command: string): Promise<string | undefined> {
  try {
    return (await execAsync(`${command} --version`)).stdout.trim().split('\n')[0]
  } catch {
    return undefined
  }
}

/**
 * Asks Node to run a real `.ts` file rather than comparing version strings.
 * Type stripping is on by default from 22.18, but a host can disable it, and
 * the failure without this check is a syntax error inside our own CLI.
 */
async function typeStripping (): Promise<Check> {
  const dir = await mkdtemp(join(tmpdir(), 'orivon-doctor-'))
  try {
    const probe = join(dir, 'probe.ts')
    await writeFile(probe, 'const ok: string = "yes"\nprocess.stdout.write(ok)\n')
    const { stdout } = await execFileAsync(process.execPath, [probe])
    return stdout.trim() === 'yes'
      ? { level: 'ok', what: 'node runs TypeScript', detail: 'type stripping works, so there is no build step' }
      : { level: 'fail', what: 'node runs TypeScript', detail: `unexpected output: ${stdout}` }
  } catch (error) {
    return {
      level: 'fail',
      what: 'node runs TypeScript',
      detail: `this node cannot run a .ts file (${error instanceof Error ? error.message.split('\n')[0] ?? '' : ''}) -- node 22.18 or newer is needed`
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function recipeShellCheck (): Promise<Check> {
  const what = 'sh (recipe commands)'
  try {
    const shell = recipeShell()
    const detail = shell === true ? '/bin/sh' : shell
    await execFileAsync(shell === true ? '/bin/sh' : shell, ['-c', 'true'])
    return { level: 'ok', what, detail }
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n').join(' ') : String(error)
    return { level: 'fail', what, detail: `${reason} -- every recipe command runs in it (${SHELL_ENV} overrides)` }
  }
}

async function portFree (port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(port, HOST, () => { probe.close(() => { resolve(true) }) })
  })
}

export async function runDoctor (): Promise<Check[]> {
  const checks: Check[] = []

  checks.push({ level: 'ok', what: 'node', detail: process.version })
  checks.push(await typeStripping())

  const git = await version('git')
  checks.push(git === undefined
    ? { level: 'fail', what: 'git', detail: 'not on PATH -- every recipe fetches its source with it' }
    : { level: 'ok', what: 'git', detail: git })

  checks.push(await recipeShellCheck())

  // Which package manager an app needs is the app's business, so a missing one
  // is only a warning here -- it becomes an error when a recipe asks for it.
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    const found = await version(manager)
    checks.push(found === undefined
      ? { level: 'warn', what: manager, detail: 'not on PATH -- fine unless a recipe needs it' }
      : { level: 'ok', what: manager, detail: found })
  }

  for (const recipe of await loadAllRecipes()) {
    checks.push(await portFree(recipe.port)
      ? { level: 'ok', what: `port ${String(recipe.port)} (${recipe.id})`, detail: 'free' }
      : { level: 'warn', what: `port ${String(recipe.port)} (${recipe.id})`, detail: 'in use -- an earlier run may still be serving' })
  }

  return checks
}

export function formatChecks (checks: readonly Check[]): string {
  const marks: Record<Level, string> = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' }
  const width = Math.max(...checks.map((check) => check.what.length))
  return checks.map((check) => `[${marks[check.level]}] ${check.what.padEnd(width)}  ${check.detail}`).join('\n')
}
