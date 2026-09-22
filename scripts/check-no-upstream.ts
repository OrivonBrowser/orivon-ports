// The licensing boundary, made mechanical.
//
// No third-party source and no third-party build output may ever be tracked
// here. Two ways it could get in: something under out/ gets committed, or a
// file appears in an app directory that is not one of the few files a port is
// allowed to consist of. Both are checked by what git actually tracks, not by
// what is on disk.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { report, REPO_ROOT } from './lib.ts'

const execFileAsync = promisify(execFile)

/**
 * Everything a port is allowed to be. It is an allowlist rather than a
 * heuristic because the thing being prevented -- somebody's AGPL source
 * landing in a public repository -- is not a thing to catch nine times in ten.
 */
const ALLOWED = [
  /^apps\/[a-z0-9-]+\/recipe\.json$/,
  /^apps\/[a-z0-9-]+\/orivon\.json$/,
  /^apps\/[a-z0-9-]+\/README\.md$/,
  /^apps\/[a-z0-9-]+\/UPSTREAM\.md$/,
  /^apps\/[a-z0-9-]+\/hooks\.mjs$/,
  /^apps\/[a-z0-9-]+\/[a-z0-9.-]*config\.(?:cjs|mjs|js)$/,
  /^apps\/[a-z0-9-]+\/bridge\/[a-zA-Z0-9.-]+\.(?:js|ts)$/,
  // A member declaration (src/bridge/): ours, written from the app's call
  // sites, holding no code of theirs.
  /^apps\/[a-z0-9-]+\/bridge\/members\.json$/
]

const tracked = (await execFileAsync('git', ['ls-files'], { cwd: REPO_ROOT })).stdout.split('\n').filter(Boolean)
const problems: string[] = []

for (const path of tracked) {
  if (path.startsWith('out/')) {
    problems.push(`${path} is tracked -- out/ is a cache of somebody else's code and must never be committed`)
    continue
  }
  if (!path.startsWith('apps/')) continue
  if (ALLOWED.some((pattern) => pattern.test(path))) continue
  problems.push(`${path} is not one of the files a port may consist of -- if it is genuinely ours, add its shape to ALLOWED in scripts/check-no-upstream.ts and say why in the app's UPSTREAM.md`)
}

report('check:no-upstream', problems)
