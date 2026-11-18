// What the board manager keeps on disk for a person's boards: the three files in the shapes its own CLI writes, read back
// as they were written, and what a page may change in them. Real files in a temporary folder, the way the Worker has them.
import * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyChange, boardConfigStore, checkAddress, checkPatch, ConfigError } from '../worker/board-config.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'bitsocial-board-config-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const store = () => boardConfigStore({ directory: dir, fs: fs as never })

describe('checkAddress', () => {
  it.each(['music-posting.bso', '12D3KooWAbCdEfGhIjKlMn', 'музыка.bso'])('takes %s: a name or a key is a folder name', (address) => {
    expect(checkAddress(address)).toBe(address)
  })

  it.each(['', '.', '..', '../escape', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256), 5, null, undefined])('refuses %j: an address from a page is never a path', (address) => {
    expect(() => checkAddress(address)).toThrow(ConfigError)
  })
})

describe('checkPatch', () => {
  it('splits what is set from what goes back to the default', () => {
    expect(checkPatch({ perPage: 20, bumpLimit: null, moderationReasons: { purgeArchived: 'gone' } })).toEqual({ set: { perPage: 20, moderationReasons: { purgeArchived: 'gone' } }, reset: ['bumpLimit'] })
  })

  it('takes `enabled` only where the caller allows it', () => {
    expect(() => checkPatch({ enabled: false })).toThrow(/enabled is not a setting/)
    expect(checkPatch({ enabled: false }, { enabled: true }).set).toEqual({ enabled: false })
    expect(() => checkPatch({ enabled: 'no' }, { enabled: true })).toThrow(/true or false/)
  })

  it.each([
    [{ perPage: 0 }, /perPage must be a positive integer/],
    [{ pages: 1.5 }, /pages must be a positive integer/],
    [{ bumpLimit: '300' }, /bumpLimit must be a positive integer/],
    [{ archivePurgeSeconds: -1 }, /archivePurgeSeconds must be a positive integer/],
    [{ address: 'other.bso' }, /address is not a setting/],
    [{ rpcUrl: 'ws://x' }, /rpcUrl is not a setting/],
    [{ moderationReasons: { lockBumpLimit: 'x' } }, /unknown key "lockBumpLimit"/],
    [{ moderationReasons: { purgeArchived: '' } }, /1 to 300 characters/],
    [{ moderationReasons: 'gone' }, /must be an object/],
    ['nothing', /must be an object/],
    [[], /must be an object/]
  ])('refuses %j', (patch, message) => {
    expect(() => checkPatch(patch)).toThrow(message)
  })

  it('applyChange sets and removes, and leaves the rest', () => {
    expect(applyChange({ perPage: 15, pages: 10, bumpLimit: 300 }, { set: { perPage: 20 }, reset: ['bumpLimit'] })).toEqual({ perPage: 20, pages: 10 })
  })
})

describe('boardConfigStore', () => {
  it('reads nothing from a folder that has nothing', () => {
    expect(store().load()).toEqual({ global: {}, boards: [], problems: [] })
  })

  it('writes a board and reads it back, in the folder and the file the manager\'s CLI uses', () => {
    const files = store()
    files.writeBoard({ address: 'music-posting.bso', perPage: 10, bumpLimit: 100 })
    files.writeGlobal({ defaults: { pages: 5, archivePurgeSeconds: 3600 } })
    expect(JSON.parse(fs.readFileSync(join(dir, 'boards', 'music-posting.bso', 'config.json'), 'utf-8'))).toEqual({ address: 'music-posting.bso', perPage: 10, bumpLimit: 100 })
    expect(JSON.parse(fs.readFileSync(join(dir, 'global.json'), 'utf-8'))).toEqual({ defaults: { pages: 5, archivePurgeSeconds: 3600 } })
    expect(files.load()).toEqual({ global: { defaults: { pages: 5, archivePurgeSeconds: 3600 } }, boards: [{ address: 'music-posting.bso', perPage: 10, bumpLimit: 100 }], problems: [] })
    expect(fs.readdirSync(join(dir, 'boards', 'music-posting.bso'))).toEqual(['config.json'])
  })

  it('keeps a key it does not know, the way the manager\'s CLI keeps one, and reads a board with `enabled: false`', () => {
    const files = store()
    files.writeBoard({ address: 'a.bso', enabled: false, perPage: 3, keptByTheCli: 'yes' } as never)
    expect(files.load().boards).toEqual([{ address: 'a.bso', enabled: false, perPage: 3, keptByTheCli: 'yes' }])
  })

  it('lists boards in address order and names a board it cannot read without losing the others', () => {
    const files = store()
    files.writeBoard({ address: 'b.bso' })
    files.writeBoard({ address: 'a.bso' })
    fs.mkdirSync(join(dir, 'boards', 'broken.bso'), { recursive: true })
    fs.writeFileSync(join(dir, 'boards', 'broken.bso', 'config.json'), '{ nope')
    fs.mkdirSync(join(dir, 'boards', 'wrong.bso'), { recursive: true })
    fs.writeFileSync(join(dir, 'boards', 'wrong.bso', 'config.json'), JSON.stringify({ address: 'other.bso' }))
    fs.mkdirSync(join(dir, 'boards', 'bad-number.bso'), { recursive: true })
    fs.writeFileSync(join(dir, 'boards', 'bad-number.bso', 'config.json'), JSON.stringify({ address: 'bad-number.bso', perPage: 0 }))
    fs.mkdirSync(join(dir, 'boards', 'empty.bso'), { recursive: true })
    const loaded = files.load()
    expect(loaded.boards.map((board) => board.address)).toEqual(['a.bso', 'b.bso'])
    expect(loaded.problems).toHaveLength(3)
    expect(loaded.problems.join('\n')).toMatch(/broken\.bso.*not JSON/)
    expect(loaded.problems.join('\n')).toMatch(/the folder is "wrong\.bso"/)
    expect(loaded.problems.join('\n')).toMatch(/bad-number\.bso.*perPage must be a positive integer/)
  })

  it('names a global.json it cannot use, and goes on with defaults of none', () => {
    fs.writeFileSync(join(dir, 'global.json'), JSON.stringify({ defaults: { perPage: 'many' } }))
    const loaded = store().load()
    expect(loaded.global).toEqual({})
    expect(loaded.problems[0]).toMatch(/perPage must be a positive integer/)
  })

  it('writes through a temporary file, so a failed write leaves the old config and no stray file', () => {
    const files = store()
    files.writeBoard({ address: 'a.bso', perPage: 1 })
    const broken = { ...fs, renameSync: () => { throw new Error('disk full') } }
    expect(() => boardConfigStore({ directory: dir, fs: broken as never }).writeBoard({ address: 'a.bso', perPage: 2 })).toThrow('disk full')
    expect(files.load().boards).toEqual([{ address: 'a.bso', perPage: 1 }])
    expect(fs.readdirSync(join(dir, 'boards', 'a.bso'))).toEqual(['config.json'])
  })

  it('never writes outside the folder: an address that is a path is refused before the disk is touched', () => {
    expect(() => store().writeBoard({ address: '../escape' })).toThrow(ConfigError)
    expect(() => store().boardDir('a/b')).toThrow(ConfigError)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('renames a board\'s folder and its address together, state file with it, and refuses a name taken', () => {
    const files = store()
    files.writeBoard({ address: 'old.bso', perPage: 4 })
    fs.writeFileSync(join(dir, 'boards', 'old.bso', 'state.json'), JSON.stringify({ signers: {}, archivedThreads: { x: { archivedTimestamp: 1 } } }))
    files.renameBoard('old.bso', 'new.bso')
    expect(files.load().boards).toEqual([{ address: 'new.bso', perPage: 4 }])
    expect(files.archivedThreads('new.bso')).toBe(1)
    files.writeBoard({ address: 'taken.bso' })
    expect(() => files.renameBoard('new.bso', 'taken.bso')).toThrow(/exists already/)
  })

  it('counts the threads the manager archived and reads no key out of its state file', () => {
    const files = store()
    files.writeBoard({ address: 'a.bso' })
    expect(files.archivedThreads('a.bso')).toBe(0)
    fs.writeFileSync(join(dir, 'boards', 'a.bso', 'state.json'), JSON.stringify({ signers: { 'a.bso': { privateKey: 'SECRET' } }, archivedThreads: { c1: { archivedTimestamp: 1 }, c2: { archivedTimestamp: 2 } } }))
    expect(files.archivedThreads('a.bso')).toBe(2)
    expect(String(files.archivedThreads('a.bso'))).not.toContain('SECRET')
    fs.writeFileSync(join(dir, 'boards', 'a.bso', 'state.json'), 'not json')
    expect(files.archivedThreads('a.bso')).toBe(0)
  })
})
