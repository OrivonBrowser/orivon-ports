import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Overrides the shell recipe commands run in, on any platform. */
export const SHELL_ENV = 'ORIVON_PORTS_SHELL'

/**
 * The POSIX `sh` recipe commands run in: `true` (Node's `/bin/sh`) outside
 * Windows, Git for Windows' bash on it. A recipe is written once, so its
 * commands are POSIX on every platform, and `cmd.exe` cannot run
 * `VAR=x cmd` or a single-quoted path.
 */
export function recipeShell (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | true {
  const override = env[SHELL_ENV]
  if (override !== undefined && override !== '') return override
  if (platform !== 'win32') return true
  const found = gitBash()
  if (found === undefined) {
    throw new Error(
      'recipe commands are POSIX sh, and no Git for Windows bash was found beside `git`.\n' +
      `  Install Git for Windows (the full installer, not MinGit), or set ${SHELL_ENV} to a bash.exe`
    )
  }
  return found
}

/** `git --exec-path` is `<root>/<mingw64|clangarm64>/libexec/git-core`; bash sits in `<root>/bin`. */
function gitBash (): string | undefined {
  let execPath: string
  try {
    execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
  const root = resolve(execPath, '..', '..', '..')
  return [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')].find((candidate) => existsSync(candidate))
}

/** One argument for a POSIX shell: single-quoted, so spaces, `$` and backslashes stay literal. */
export function shellQuote (value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
