import { describe, expect, it } from 'vitest'
import { cliCommands, skillProblems, type SkillFacts, type SkillFile } from './skill-refs.ts'

const EXISTING = new Set(['docs/porting-guide.md', 'src/cli.ts', 'apps/a', 'apps/b', '.claude/skills/x/other.md'])

const facts = (apps: string[] = ['a']): SkillFacts => ({
  exists: (path) => EXISTING.has(path),
  roots: new Set(['apps', 'docs', 'src', '.claude']),
  commands: new Set(['run', 'build', 'recon']),
  apps
})

const TABLE = '| App | Shape |\n|---|---|\n| `apps/a/` | a shape |\n'
const skill = (text: string): SkillFile[] => [{ path: '.claude/skills/x/SKILL.md', text: `${TABLE}${text}` }]

describe('skillProblems', () => {
  it('passes a skill whose paths, commands and apps are all current', () => {
    const text = 'Read [the guide](../../../docs/porting-guide.md), `src/cli.ts`, [more](other.md).\n`node src/cli.ts run <app>`'
    expect(skillProblems(skill(text), facts())).toEqual([])
  })

  it('names a cited path in this repository that does not exist', () => {
    expect(skillProblems(skill('see `src/gone.ts`'), facts())).toEqual([
      '.claude/skills/x/SKILL.md: cites `src/gone.ts`, which does not exist'
    ])
  })

  it('names a link that does not resolve, relative to the file it is in', () => {
    expect(skillProblems(skill('[x](../../../docs/gone.md)'), facts())).toEqual([
      '.claude/skills/x/SKILL.md: links to ../../../docs/gone.md, which does not exist'
    ])
  })

  // The sibling checkout is not here in CI, and this repository must build without it.
  it('leaves paths into the sibling checkout, placeholders, web links and anchors alone', () => {
    const text = '`../orivon-mvp/src/x.ts` `apps/<id>/bridge/` `out/x` [w](https://example.com) [a](#port-or-orivon) [m](../../../../orivon-mvp/x.md)'
    expect(skillProblems(skill(text), facts())).toEqual([])
  })

  it('does not read a path inside a fenced block as a citation', () => {
    expect(skillProblems(skill('```bash\ncat src/gone.ts\n```\n'), facts())).toEqual([])
  })

  it('names a command the CLI does not have, fenced or not', () => {
    expect(skillProblems(skill('```bash\nnode src/cli.ts publish x\n```\nthen `orivon-port bump x`'), facts())).toEqual([
      '.claude/skills/x/SKILL.md: names the command "publish", which src/cli.ts does not have',
      '.claude/skills/x/SKILL.md: names the command "bump", which src/cli.ts does not have'
    ])
  })

  it('names an app with no row in any table of the skill', () => {
    expect(skillProblems(skill('mentions `apps/b/` in prose only'), facts(['a', 'b']))).toEqual([
      "apps/b/ has no row in the skill's shapes table -- say what shape it is and what to copy it for"
    ])
  })

  it('accepts an app row kept in another file of the skill', () => {
    const files = [...skill(''), { path: '.claude/skills/x/more.md', text: '| `apps/b/` | another shape |\n' }]
    expect(skillProblems(files, facts(['a', 'b']))).toEqual([])
  })
})

describe('cliCommands', () => {
  it('reads every case label the CLI dispatches on', () => {
    const source = "switch (command) {\n  case 'doctor': {\n  case 'list': return x\n  case 'new': {\n}"
    expect([...cliCommands(source)]).toEqual(['doctor', 'list', 'new'])
  })
})
