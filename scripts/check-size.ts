// No source file over 500 lines, no test file over 800. A file at that length
// has almost always stopped being one thing.
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { report, REPO_ROOT, walk } from './lib.ts'

export const SOURCE_LIMIT = 500
export const TEST_LIMIT = 800

const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const DECLARATION = /\.d\.ts$/
const TEST = /\.test\.[cm]?tsx?$/

const problems: string[] = []
for (const file of await walk(REPO_ROOT, CODE)) {
  if (DECLARATION.test(file)) continue
  const lines = (await readFile(file, 'utf8')).split('\n').length
  const limit = TEST.test(file) ? TEST_LIMIT : SOURCE_LIMIT
  if (lines > limit) problems.push(`${relative(REPO_ROOT, file)}: ${String(lines)} lines, limit ${String(limit)}`)
}
report('check:size', problems)
