import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXTRA_APPS_ENV, extraApps } from './paths.ts'

function app (root: string, dir: string, id: string): string {
  const path = join(root, dir)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'recipe.json'), JSON.stringify({ id }))
  return path
}

describe('extraApps', () => {
  const env = (value: string): NodeJS.ProcessEnv => ({ [EXTRA_APPS_ENV]: value })

  it('finds nothing when the variable is unset', () => {
    expect(extraApps({}).size).toBe(0)
  })

  it('reads one app directory and names it by its recipe id', () => {
    const root = mkdtempSync(join(tmpdir(), 'extra-apps-'))
    const dir = app(root, 'whatever-name', 'my-app')
    expect([...extraApps(env(dir))]).toEqual([['my-app', dir]])
  })

  it('reads a directory of apps laid out as apps/ is, skipping a directory with no recipe', () => {
    const root = mkdtempSync(join(tmpdir(), 'extra-apps-'))
    const first = app(root, 'one', 'one')
    const second = app(root, 'two', 'two')
    mkdirSync(join(root, 'not-an-app'))
    expect([...extraApps(env(root))].sort()).toEqual([['one', first], ['two', second]])
  })

  it('refuses an id that two entries both provide', () => {
    const root = mkdtempSync(join(tmpdir(), 'extra-apps-'))
    const first = app(root, 'a', 'same')
    const second = app(root, 'b', 'same')
    expect(() => extraApps(env(`${first}:${second}`))).toThrow(/found twice/)
  })

  it('refuses an id that is not a safe directory name', () => {
    const root = mkdtempSync(join(tmpdir(), 'extra-apps-'))
    expect(() => extraApps(env(app(root, 'x', '../escape')))).toThrow(/not an app id/)
  })
})
