// A file may not open with more than 25 lines of comment before its first
// line of code. The guard measures the leading run, not density: a file that
// is mostly comment next to the code it explains is fine, an essay every
// reader pays for before line one is not.
//
// An unavoidable block declares itself: `// orivon:comment-budget -- <why>`.
// The reason is mandatory, so the escape hatch stays visible.
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { report, REPO_ROOT, walk } from './lib.ts'

export const LEADING_LIMIT = 25

const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const TEST = /\.test\.[cm]?tsx?$/
const PRAGMA = /orivon:comment-budget\s*--\s*\S/

export function leadingCommentLines (source: string): number {
  let run = 0
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#!')) continue
    // An import does not end the run and does not extend it: a header split
    // around one is still a header.
    if (trimmed.startsWith('import ') || trimmed.startsWith('export {')) continue
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) { run += 1; continue }
    break
  }
  return run
}

const problems: string[] = []
for (const file of await walk(REPO_ROOT, CODE)) {
  if (TEST.test(file)) continue
  const source = await readFile(file, 'utf8')
  if (PRAGMA.test(source)) continue
  const run = leadingCommentLines(source)
  if (run > LEADING_LIMIT) {
    problems.push(`${relative(REPO_ROOT, file)}: ${String(run)} leading comment lines, limit ${String(LEADING_LIMIT)} -- move the rationale to the directory README, or declare it with "// orivon:comment-budget -- <why>"`)
  }
}
report('check:comments', problems)
