// What makes the porting skill stale, as a pure function over its text.
//
// The skill is read by agents who act on it without checking, so a path that
// moved, a command that was renamed or an app that was added and never
// described turns into a wrong action. This finds the three mechanically:
// a cited path in this repository that does not exist, an `orivon-port`
// command the CLI does not have, and an app under `apps/` the skill's shapes
// table does not name. A path into the sibling checkout (`../orivon-mvp/...`)
// is not checked: this repository builds and tests without that one.
import { posix } from 'node:path'

export interface SkillFile {
  /** Repository-relative, with forward slashes. */
  path: string
  text: string
}

export interface SkillFacts {
  /** Whether a repository-relative path exists. */
  exists: (path: string) => boolean
  /** The top-level directories a cited path may start with. */
  roots: ReadonlySet<string>
  /** Every command the CLI dispatches. */
  commands: ReadonlySet<string>
  /** Every app directory under `apps/`. */
  apps: readonly string[]
}

const FENCE = /^```[^\n]*\n[\s\S]*?^```/gm
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const CODE_SPAN = /`([^`\n]+)`/g
const COMMAND = /(?:orivon-port|node src\/cli\.ts)\s+([a-z][a-z-]*)/g
const PATH_LIKE = /^[A-Za-z0-9._/-]+$/

/** Code spans and links only count outside fenced blocks: a block holds commands, not citations. */
function prose (text: string): string {
  return text.replace(FENCE, '')
}

function linkProblems (file: SkillFile, facts: SkillFacts): string[] {
  const problems: string[] = []
  for (const [, target = ''] of prose(file.text).matchAll(LINK)) {
    if (/^(?:[a-z]+:|#)/.test(target)) continue
    const path = posix.normalize(posix.join(posix.dirname(file.path), target.replace(/#.*$/, '')))
    if (path.startsWith('../')) continue
    if (!facts.exists(path)) problems.push(`${file.path}: links to ${target}, which does not exist`)
  }
  return problems
}

function spanProblems (file: SkillFile, facts: SkillFacts): string[] {
  const problems: string[] = []
  for (const [, span = ''] of prose(file.text).matchAll(CODE_SPAN)) {
    if (!PATH_LIKE.test(span) || !span.includes('/')) continue
    const root = span.split('/')[0] ?? ''
    if (!facts.roots.has(root)) continue
    if (!facts.exists(span.replace(/\/$/, ''))) problems.push(`${file.path}: cites \`${span}\`, which does not exist`)
  }
  return problems
}

function commandProblems (file: SkillFile, facts: SkillFacts): string[] {
  const problems: string[] = []
  for (const [, command = ''] of file.text.matchAll(COMMAND)) {
    if (!facts.commands.has(command)) problems.push(`${file.path}: names the command "${command}", which src/cli.ts does not have`)
  }
  return problems
}

/** An app has a row when a table line in any skill file starts with its directory. */
function hasRow (files: readonly SkillFile[], app: string): boolean {
  return files.some((file) => file.text.split('\n').some((line) => line.startsWith(`| \`apps/${app}/\` |`)))
}

export function skillProblems (files: readonly SkillFile[], facts: SkillFacts): string[] {
  const problems = files.flatMap((file) => [...linkProblems(file, facts), ...spanProblems(file, facts), ...commandProblems(file, facts)])
  for (const app of facts.apps) {
    if (!hasRow(files, app)) problems.push(`apps/${app}/ has no row in the skill's shapes table -- say what shape it is and what to copy it for`)
  }
  return [...new Set(problems)]
}

/** The commands `src/cli.ts` dispatches, read from its `case` labels. */
export function cliCommands (source: string): Set<string> {
  return new Set([...source.matchAll(/case '([a-z][a-z-]*)'/g)].map(([, command = '']) => command))
}
