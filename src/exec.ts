import { spawn } from 'node:child_process'

/**
 * Runs one of a recipe's shell commands and streams its output through.
 *
 * THE COMMAND IS THE APP'S OWN BUILD, which is third-party code running with
 * this user's privileges. That is inherent to porting -- there is no way to
 * build somebody's app without running their toolchain -- and it is why
 * `upstream.ref` is pinned to a commit rather than a branch. SECURITY.md says
 * this out loud.
 */
export async function run (command: string, cwd: string, label: string): Promise<void> {
  process.stdout.write(`[${label}] ${command}\n`)
  const child = spawn(command, { cwd, shell: true, stdio: 'inherit' })

  await new Promise<void>((resolve, reject) => {
    child.once('error', (error: Error) => {
      reject(new Error(`[${label}] could not start: ${error.message}\n  command: ${command}\n  in: ${cwd}`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) { resolve(); return }
      const how = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      reject(new Error(`[${label}] failed (${how})\n  command: ${command}\n  in: ${cwd}`))
    })
  })
}
