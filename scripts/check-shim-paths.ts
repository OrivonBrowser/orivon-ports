// Every build wrapper that bundles Orivon's Node shim writes the same bytes on
// any machine: its esbuild `plugins` end with `stableBundlePaths()`. The rules
// are in shim-paths.ts; this only gathers the wrappers.
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { report, REPO_ROOT, walk } from './lib.ts'
import { shimPathProblems, type BuildFile } from './shim-paths.ts'

const CODE = /\.(?:ts|mjs|cjs|js)$/
const TEST = /\.test\.[cm]?[jt]s$/

const files: BuildFile[] = []
for (const path of await walk(join(REPO_ROOT, 'apps'), CODE)) {
  if (TEST.test(path)) continue
  files.push({ path: relative(REPO_ROOT, path).split('\\').join('/'), text: await readFile(path, 'utf8') })
}

report('check:shim-paths', shimPathProblems(files))
