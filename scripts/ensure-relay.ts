// Orivon Share's relay has its own dependencies, and `typecheck` and `test`
// cover it: install them first when a fresh checkout has none.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './lib.ts'

if (!existsSync(join(REPO_ROOT, 'apps/share/relay/node_modules'))) {
  const run = spawnSync('npm', ['run', 'relay:install'], { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  process.exit(run.status ?? 1)
}
