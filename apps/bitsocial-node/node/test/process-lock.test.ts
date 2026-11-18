// The in-process stand-in for proper-lock-file's start lock, against a real directory.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import lockModule, { check, checkSync, lock, lockSync, unlock, unlockSync } from '../worker/workarounds/process-lock.js'

let dir: string
let community: string
let lockfilePath: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bitsocial-lock-'))
  community = join(dir, 'communities', 'abc')
  lockfilePath = `${community}.start.lock`
  await mkdir(join(dir, 'communities'), { recursive: true })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('process lock', () => {
  it('has the library\'s shape: a function that is also an object of the six calls', () => {
    expect(typeof lockModule).toBe('function')
    expect(lockModule.lock).toBe(lock)
    expect(lockModule.checkSync).toBe(checkSync)
  })

  it('makes the lock directory pkc-js looks for, holds it, and removes it on release', async () => {
    const release = await lock(community, { lockfilePath })
    expect(existsSync(lockfilePath)).toBe(true)
    expect(await check(community, { lockfilePath })).toBe(true)
    await release()
    expect(existsSync(lockfilePath)).toBe(false)
    expect(await check(community, { lockfilePath })).toBe(false)
  })

  it('refuses a second lock with the text pkc-js matches, and allows one after the release', async () => {
    const release = await lock(community, { lockfilePath })
    await expect(lock(community, { lockfilePath })).rejects.toMatchObject({ message: 'Lock file is already being held', code: 'ELOCKED' })
    await release()
    await (await lock(community, { lockfilePath }))()
  })

  it('retries a held lock the number of times it was asked to, then refuses', async () => {
    const release = await lock(community, { lockfilePath })
    setTimeout(() => { release().catch(() => {}) }, 150)
    await (await lock(community, { lockfilePath, retries: 3 }))()
    const held = await lock(community, { lockfilePath })
    await expect(lock(community, { lockfilePath, retries: 1 })).rejects.toMatchObject({ code: 'ELOCKED' })
    await held()
  })

  it('takes over a lock directory an earlier run left behind', async () => {
    await mkdir(lockfilePath)
    expect(await check(community, { lockfilePath })).toBe(false)
    await (await lock(community, { lockfilePath }))()
  })

  it('refuses to unlock what is not locked, as the library does', async () => {
    await expect(unlock(community, { lockfilePath })).rejects.toMatchObject({ code: 'ENOTACQUIRED' })
  })

  it('keeps locks of different files apart', async () => {
    const other = join(dir, 'communities', 'other')
    const first = await lock(community, { lockfilePath })
    const second = await lock(other, { lockfilePath: `${other}.start.lock` })
    await first()
    await second()
  })

  it('has the same three calls without waiting', () => {
    const release = lockSync(community, { lockfilePath })
    expect(checkSync(community, { lockfilePath })).toBe(true)
    expect(() => lockSync(community, { lockfilePath })).toThrow('Lock file is already being held')
    release()
    expect(checkSync(community, { lockfilePath })).toBe(false)
    expect(() => unlockSync(community, { lockfilePath })).toThrow(/not acquired/)
  })
})
