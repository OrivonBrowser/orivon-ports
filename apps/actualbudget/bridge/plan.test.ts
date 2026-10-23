// plan.js: the decisions the page and the build both rely on.
import { describe, expect, it } from 'vitest'
import {
  ACTUAL_VERSION, backendArgs, backendDirs, backendEnv, bytesOf, BUNDLE_FILE, busyFailure, exitFailure, failurePayload, importTarget, installDirFor,
  installNeeded, installUrl, moduleLocation, needsActivation, parentOf, parseInstall, safeFileName, staleInstalls, withModuleScope
} from './plan.js'

describe('where the backend believes it lives', () => {
  const root = '/orivon/app/actual-install/abc'
  it('gives only the backend bundle a location, two levels below the directory that holds the database template', () => {
    expect(moduleLocation('/clone/b.js', '/clone/b.js', root)).toEqual({ dirname: `${root}/lib-dist/electron`, filename: `${root}/${BUNDLE_FILE}` })
    expect(moduleLocation('/clone/other.js', '/clone/b.js', root)).toBeNull()
  })

  it('names the bundle bundle.desktop.js, which upstream\'s rootPath test compares', () => {
    expect(BUNDLE_FILE.endsWith('/bundle.desktop.js')).toBe(true)
  })

  it('declares the names on the first line, and leaves a file with no location alone', () => {
    const location = { dirname: '/a/b', filename: '/a/b/c.js' }
    expect(withModuleScope('exports.x = __dirname', location)).toBe('const __dirname = "/a/b", __filename = "/a/b/c.js"; exports.x = __dirname')
    expect(withModuleScope('x', null)).toBe('x')
    expect(withModuleScope('a\nb', location).split('\n')).toHaveLength(2)
  })

  it('puts each build\'s install tree in a directory of its own', () => {
    expect(installDirFor('abc')).toBe('actual-install/abc')
  })
})

describe('what the backend is run with', () => {
  it('keeps both of upstream\'s directories inside the app\'s files', () => {
    const env = backendEnv('/orivon/app')
    expect(env['ACTUAL_DATA_DIR']).toBe('/orivon/app/actual-data')
    expect(env['ACTUAL_DOCUMENT_DIR']).toBe('/orivon/app/actual-documents')
    expect(env['NODE_ENV']).toBe('production')
  })

  it('passes the arguments Electron\'s main passes', () => {
    expect(backendArgs()).toEqual(['--subprocess', ACTUAL_VERSION])
  })

  it('makes the three directories before the backend starts', () => {
    expect(backendDirs()).toEqual(['actual-data', 'actual-documents', 'actual-imports'])
  })
})

describe('failures', () => {
  it('reports a document-directory error with its path and code, as upstream\'s server.ts does', () => {
    const error = Object.assign(new Error('cannot use'), { type: 'DocumentDirError', path: '/x', code: 'EACCES' })
    expect(failurePayload(error)).toMatchObject({ type: 'app-init-failure', DocumentDirFailure: true, path: '/x', code: 'EACCES', message: 'cannot use' })
  })

  it('reports any other error as a backend failure with its message', () => {
    expect(failurePayload(new Error('boom'))).toMatchObject({ type: 'app-init-failure', BackendInitFailure: true, message: 'boom' })
    expect(failurePayload('text')).toMatchObject({ BackendInitFailure: true, message: 'text' })
  })

  it('says an unexpected exit with the code, and a second page in words the person can act on', () => {
    expect(exitFailure(1).message).toBe('The backend process exited unexpectedly (exit code 1)')
    expect(busyFailure().message).toContain('already open in another tab')
  })
})

describe('file names', () => {
  it('keeps a plain name and its extension', () => {
    expect(safeFileName('2026-10-01-My budget.zip')).toBe('2026-10-01-My budget.zip')
    expect(safeFileName('budget é.csv')).toBe('budget é.csv')
  })

  it('drops directories, leading dots and characters a path should not carry', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\a\\b.qif')).toBe('b.qif')
    expect(safeFileName('.hidden')).toBe('hidden')
    expect(safeFileName('a<b>:c.txt')).toBe('a_b__c.txt')
  })

  it('falls back when nothing is left', () => {
    expect(safeFileName('', 'export')).toBe('export')
    expect(safeFileName(undefined)).toBe('file')
    expect(safeFileName('...')).toBe('file')
  })

  it('bounds the length and keeps a short extension', () => {
    const long = `${'a'.repeat(300)}.zip`
    const out = safeFileName(long)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith('.zip')).toBe(true)
  })

  it('copies a pick to a directory of its own under the app\'s files, so two picks never share a name', () => {
    const one = importTarget('/orivon/app', 'a1', 'x.zip')
    const two = importTarget('/orivon/app', 'b2', 'x.zip')
    expect(one.absolute).toBe('/orivon/app/actual-imports/a1/x.zip')
    expect(one.relative).toBe('actual-imports/a1/x.zip')
    expect(one.directory).toBe('actual-imports/a1')
    expect(two.absolute).not.toBe(one.absolute)
  })
})

describe('bytesOf', () => {
  it('turns text into UTF-8, passes bytes through, and reads a Buffer that crossed as JSON', () => {
    expect(Array.from(bytesOf('é'))).toEqual([0xc3, 0xa9])
    const bytes = new Uint8Array([1, 2])
    expect(bytesOf(bytes)).toBe(bytes)
    expect(Array.from(bytesOf(new Uint16Array([1]).buffer))).toEqual([1, 0])
    expect(Array.from(bytesOf({ type: 'Buffer', data: [7, 8] }))).toEqual([7, 8])
  })

  it('refuses anything else', () => {
    expect(() => bytesOf(42)).toThrow(TypeError)
    expect(() => bytesOf(null)).toThrow(TypeError)
  })
})

describe('needsActivation', () => {
  it('is true for the picker\'s refusal for want of a click, and false for anything else', () => {
    expect(needsActivation({ code: 'denied' })).toBe(true)
    expect(needsActivation({ code: 'limit' })).toBe(false)
    expect(needsActivation(null)).toBe(false)
  })
})

describe('the install tree', () => {
  const good = JSON.stringify({ stamp: 'abcdef0123456789', files: ['default-db.sqlite', 'migrations/1_a.sql'] })

  it('reads a stamp and a list of relative names', () => {
    expect(parseInstall(good)).toEqual({ stamp: 'abcdef0123456789', files: ['default-db.sqlite', 'migrations/1_a.sql'] })
  })

  it('refuses a missing stamp, an empty list and a name that climbs out or is absolute', () => {
    expect(() => parseInstall(JSON.stringify({ files: ['a'] }))).toThrow(/no stamp/)
    expect(() => parseInstall(JSON.stringify({ stamp: 'abcdef0123456789', files: [] }))).toThrow(/no stamp or no files/)
    expect(() => parseInstall(JSON.stringify({ stamp: 'abcdef0123456789', files: ['../x'] }))).toThrow(/outside/)
    expect(() => parseInstall(JSON.stringify({ stamp: 'abcdef0123456789', files: ['/x'] }))).toThrow(/outside/)
    expect(() => parseInstall(JSON.stringify({ stamp: 'abcdef0123456789', files: [''] }))).toThrow(/outside/)
  })

  it('writes the tree when none is stored or the stored one is another build\'s', () => {
    const served = parseInstall(good)
    expect(installNeeded(served, null)).toBe(true)
    expect(installNeeded(served, { stamp: '0000000000000000', files: ['x'] })).toBe(true)
    expect(installNeeded(served, served)).toBe(false)
  })

  it('finds a file\'s directory and URL', () => {
    expect(parentOf('migrations/a.sql')).toBe('migrations')
    expect(parentOf('default-db.sqlite')).toBe('')
    expect(installUrl('migrations/a b.sql')).toBe('install/migrations/a%20b.sql')
  })

  it('lists the other builds\' trees as stale', () => {
    expect(staleInstalls(['old', 'now', 'older'], 'now')).toEqual(['old', 'older'])
  })
})
