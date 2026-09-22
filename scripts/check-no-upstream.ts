// The licensing boundary, made mechanical.
//
// No third-party source and no third-party build output may ever be tracked
// here. Two ways it could get in: something under out/ gets committed, or a
// file appears in an app directory that is not one of the few files a port is
// allowed to consist of. Both are checked by what git actually tracks, not by
// what is on disk. The allowlist itself is in app-files.ts.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isSite } from '../src/recipe.ts'
import { isAllowedAppFile } from './app-files.ts'
import { recipesOrReport, report, REPO_ROOT } from './lib.ts'

const execFileAsync = promisify(execFile)

const sites = (await recipesOrReport('check:no-upstream')).filter(isSite).map((recipe) => `apps/${recipe.id}/${recipe.site}`)
const tracked = (await execFileAsync('git', ['ls-files'], { cwd: REPO_ROOT })).stdout.split('\n').filter(Boolean)
const problems: string[] = []

for (const path of tracked) {
  if (path.startsWith('out/')) {
    problems.push(`${path} is tracked -- out/ is a cache of somebody else's code and must never be committed`)
    continue
  }
  if (!path.startsWith('apps/')) continue
  if (isAllowedAppFile(path, sites)) continue
  problems.push(`${path} is not one of the files a port may consist of -- if it is genuinely ours, add its shape to scripts/app-files.ts and say why in the app's UPSTREAM.md`)
}

report('check:no-upstream', problems)
