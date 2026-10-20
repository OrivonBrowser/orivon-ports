import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { movePin, openPinPrs, pinBranch, pinPrBody, pinPrTitle } from './pin-pr.ts'
import type { Runner } from './pin-pr.ts'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const update = { kind: 'update' as const, app: 'demo', name: 'Demo', pinned: OLD, tag: 'v2.0', commit: NEW, url: 'https://github.com/o/r/releases/tag/v2.0', published: '2026-10-01', notes: '' }

describe('movePin', () => {
  const recipe = `{\n  "upstream": {\n    "repo": "https://github.com/o/r.git",\n    "ref": "${OLD}",\n    "licence": "MIT"\n  }\n}\n`

  it('changes the ref and nothing else', () => {
    expect(movePin(recipe, OLD, NEW)).toBe(recipe.replace(OLD, NEW))
  })

  it('refuses a recipe that does not hold the old ref once', () => {
    expect(() => movePin(recipe, 'c'.repeat(40), NEW)).toThrow(/exactly once/)
    expect(() => movePin(`${recipe}${recipe}`, OLD, NEW)).toThrow(/exactly once/)
  })
})

describe('names', () => {
  it('makes a branch git accepts from the app and any tag', () => {
    expect(pinBranch('ledger-wallet', '@ledgerhq/live-desktop@4.24.0')).toBe('pin/ledger-wallet-ledgerhq-live-desktop-4.24.0')
    expect(pinBranch('demo', 'v2.0')).toBe('pin/demo-v2.0')
  })

  it('titles the pull request and lists what is left to do in the body', () => {
    expect(pinPrTitle(update)).toBe('Move Demo to v2.0')
    expect(pinPrBody(update)).toContain(`commit \`${NEW}\``)
    expect(pinPrBody(update)).toContain('- [ ] `UPSTREAM.md`')
  })
})

describe('openPinPrs', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-pin-'))
    await mkdir(join(root, 'apps', 'demo'), { recursive: true })
    await writeFile(join(root, 'apps', 'demo', 'recipe.json'), `{ "ref": "${OLD}" }\n`)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  function runner (existing: string[] = []): Runner & { calls: string[][] } {
    const calls: string[][] = []
    return {
      calls,
      run: async (command, args) => {
        calls.push([command, ...args])
        if (args[0] === 'ls-remote') return { code: existing.includes(args[args.length - 1] ?? '') ? 0 : 2, stdout: '' }
        return { code: 0, stdout: '' }
      }
    }
  }

  it('moves the pin on a branch of its own and opens a draft pull request, then returns to the base', async () => {
    const fake = runner()
    expect(await openPinPrs([update], root, 'main', fake)).toEqual(['pin/demo-v2.0'])
    expect(await readFile(join(root, 'apps', 'demo', 'recipe.json'), 'utf8')).toBe(`{ "ref": "${NEW}" }\n`)
    const verbs = fake.calls.map((call) => call.slice(0, 4).join(' '))
    expect(verbs).toContain('git switch -c pin/demo-v2.0')
    expect(fake.calls.find((call) => call[0] === 'gh')).toEqual(expect.arrayContaining(['pr', 'create', '--draft', '--base', 'main', '--head', 'pin/demo-v2.0']))
    expect(fake.calls[fake.calls.length - 1]).toEqual(['git', 'switch', '-q', '--discard-changes', 'main'])
  })

  it('skips an update whose branch already exists', async () => {
    const fake = runner(['pin/demo-v2.0'])
    expect(await openPinPrs([update], root, 'main', fake)).toEqual([])
    expect(fake.calls.every((call) => call[1] === 'ls-remote')).toBe(true)
    expect(await readFile(join(root, 'apps', 'demo', 'recipe.json'), 'utf8')).toContain(OLD)
  })
})
