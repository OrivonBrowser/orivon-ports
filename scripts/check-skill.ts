// The porting skill still matches the repository: its cited paths exist, the
// commands it names are the CLI's, and every app has a row in its shapes
// table. The rules are in skill-refs.ts; this only gathers the facts.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT, report } from './lib.ts'
import { cliCommands, skillProblems } from './skill-refs.ts'

const SKILL_DIR = '.claude/skills/orivon-porting'
const NOT_ROOTS = new Set(['.git', 'node_modules', 'out', 'dist', 'coverage'])

const dirs = (path: string): string[] =>
  readdirSync(join(REPO_ROOT, path), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

const files = readdirSync(join(REPO_ROOT, SKILL_DIR))
  .filter((name) => name.endsWith('.md'))
  .map((name) => ({ path: `${SKILL_DIR}/${name}`, text: readFileSync(join(REPO_ROOT, SKILL_DIR, name), 'utf8') }))

report('check:skill', skillProblems(files, {
  exists: (path) => existsSync(join(REPO_ROOT, path)),
  roots: new Set(dirs('.').filter((name) => !NOT_ROOTS.has(name))),
  commands: cliCommands(readFileSync(join(REPO_ROOT, 'src/cli.ts'), 'utf8')),
  apps: dirs('apps')
}))
