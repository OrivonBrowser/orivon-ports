// Two apps keep dependencies of their own in a directory with its own lockfile (Orivon Share's relay, Bitsocial
// Node's node), and `typecheck` and `test` cover both: install each first when a fresh checkout has none.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './lib.ts'

const INSTALLS = [
  { directory: 'apps/share/relay', script: 'relay:install' },
  { directory: 'apps/bitsocial-node/node', script: 'bitsocial-node:install' }
]

for (const { directory, script } of INSTALLS) {
  if (existsSync(join(REPO_ROOT, directory, 'node_modules'))) continue
  const run = spawnSync('npm', ['run', script], { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
