import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILD_DIR_ENV, EXTRA_APPS_ENV, REPO_ROOT, buildDir, buildRoot, dirsFor, extraApps, sourceDir } from './paths.ts'

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
    expect(() => extraApps(env(`${first}${delimiter}${second}`))).toThrow(/found twice/)
  })

  it('refuses an id that is not a safe directory name', () => {
    const root = mkdtempSync(join(tmpdir(), 'extra-apps-'))
    expect(() => extraApps(env(app(root, 'x', '../escape')))).toThrow(/not an app id/)
  })
})

describe('buildRoot', () => {
  it('is one fixed folder on Linux and macOS, whatever TMPDIR says', () => {
    expect(buildRoot({}, 'linux')).toBe('/tmp/orivon-ports-build')
    expect(buildRoot({ TMPDIR: '/var/tmp/other' }, 'darwin')).toBe('/tmp/orivon-ports-build')
  })

  it('is a short folder on the system drive on Windows', () => {
    expect(buildRoot({ SystemDrive: 'D:' }, 'win32')).toBe('D:\\orivon-ports-build')
    expect(buildRoot({}, 'win32')).toBe('C:\\orivon-ports-build')
  })

  it('moves to the folder ORIVON_PORTS_BUILD_DIR names, made absolute', () => {
    expect(buildRoot({ [BUILD_DIR_ENV]: '/mnt/big/builds' }, 'linux')).toBe('/mnt/big/builds')
    expect(buildRoot({ [BUILD_DIR_ENV]: 'builds' }, 'linux')).toBe(resolve('builds'))
    expect(buildRoot({ [BUILD_DIR_ENV]: '' }, 'linux')).toBe('/tmp/orivon-ports-build')
  })
})

describe('where an app is built', () => {
  it('puts the clone in the build folder, outside this checkout, and the built tree inside it', () => {
    const dirs = dirsFor('freetube')
    expect(dirs.source).toBe(sourceDir('freetube'))
    expect(dirs.source).toBe(join(buildDir('freetube'), 'source'))
    expect(relative(REPO_ROOT, dirs.source).startsWith('..')).toBe(true)
    expect(relative(REPO_ROOT, dirs.static)).toBe(join('out', 'freetube', 'static'))
  })

  it('names no folder for an id that is not safe', () => {
    expect(() => buildDir('../escape')).toThrow(/not an app id/)
  })
})
