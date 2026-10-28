import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEEP_DAYS, addBlocked, addPin, blockedFile, due, endsAt, markDropped, markExpired, pinsFile, readBlocked, readPins, usage } from '../store.mjs'

const DAY = 24 * 60 * 60 * 1000

describe('the record of copies', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'share-copy-store-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('keeps what it adds, survives a line cut short, and reads an empty record', async () => {
    const file = pinsFile(dir)
    expect((await readPins(file)).size).toBe(0)
    await addPin(file, { cid: 'a', at: 5, bytes: 10, kubo: true, filebase: true, expired: false })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(file, '{"cid":"b","at":')
    await addPin(file, { cid: 'c', at: 6, bytes: 3, kubo: true, filebase: false, expired: false })
    const pins = await readPins(file)
    expect([...pins.keys()]).toEqual(['a', 'c'])
    expect(pins.get('c')).toEqual({ cid: 'c', at: 6, bytes: 3, kubo: true, filebase: false, expired: false })
  })

  it('only appends: an end or a drop is a line of its own, and a new copy follows a drop', async () => {
    const file = pinsFile(dir)
    await addPin(file, { cid: 'a', at: 1, bytes: 10, kubo: true, filebase: true, expired: false })
    await markExpired(file, 'a')
    expect((await readPins(file)).get('a')?.expired).toBe(true)
    await markDropped(file, 'a')
    expect((await readPins(file)).has('a')).toBe(false)
    await addPin(file, { cid: 'a', at: 2, bytes: 11, kubo: true, filebase: true, expired: false })
    expect((await readPins(file)).get('a')).toMatchObject({ at: 2, bytes: 11, expired: false })
  })

  it('ends a copy after its month, and counts as use only what the service pinned', async () => {
    const file = pinsFile(dir)
    const now = 100 * DAY
    await addPin(file, { cid: 'old', at: now - (KEEP_DAYS + 1) * DAY, bytes: 100, kubo: true, filebase: true, expired: false })
    await addPin(file, { cid: 'fresh', at: now - DAY, bytes: 50, kubo: true, filebase: false, expired: false })
    await addPin(file, { cid: 'held', at: now - DAY, bytes: 7, kubo: false, filebase: false, expired: false })
    const pins = await readPins(file)
    expect(due(pins, now).map((p) => p.cid).sort()).toEqual(['old'])
    expect(usage(pins, now - DAY - 1)).toEqual({ live: 150, recent: 50 })
    await markExpired(file, 'old')
    expect(usage(await readPins(file), 0)).toEqual({ live: 50, recent: 150 })
    expect(endsAt(0)).toBe(KEEP_DAYS * DAY)
  })

  it('keeps taken-down CIDs apart from the copies', async () => {
    expect((await readBlocked(blockedFile(dir))).size).toBe(0)
    await addBlocked(blockedFile(dir), 'x')
    expect([...await readBlocked(blockedFile(dir))]).toEqual(['x'])
    expect((await readPins(pinsFile(dir))).size).toBe(0)
  })
})
