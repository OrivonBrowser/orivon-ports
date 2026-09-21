import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock } from './lock.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-lock-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('acquireLock', () => {
  it('refuses a second holder while the first is alive', async () => {
    const release = await acquireLock(dir, 'ft')
    await expect(acquireLock(dir, 'ft')).rejects.toThrow(/locked by process/)
    await release()
  })

  it('lets the next run in once the lock is released', async () => {
    await (await acquireLock(dir, 'ft'))()
    await (await acquireLock(dir, 'ft'))()
  })

  // A run killed mid-build leaves its lock behind. Requiring a human to delete
  // a file before the tool works again is the kind of papercut that makes
  // people stop using it.
  it('takes over a lock whose holder is gone', async () => {
    await writeFile(join(dir, '.lock'), '2147483646')
    const release = await acquireLock(dir, 'ft')
    expect(await readFile(join(dir, '.lock'), 'utf8')).toBe(String(process.pid))
    await release()
  })

  it('takes over a lock file that holds nonsense', async () => {
    await writeFile(join(dir, '.lock'), 'not-a-pid')
    await (await acquireLock(dir, 'ft'))()
  })
})
