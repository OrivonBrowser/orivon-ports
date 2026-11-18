// What a killed node leaves in its folder: the lock directories of its two databases, removed only while no node answers.
import { describe, expect, it } from 'vitest'
import { clearLeftLocks, LOCK_NAMES } from '../worker/left-locks.js'

const DIR = '/data/files/node'

function run (options: { alive?: boolean | Error, missing?: string[], fails?: string[] } = {}) {
  const removed: string[] = []
  const lines: string[] = []
  const done = clearLeftLocks({
    directory: DIR,
    removeDir: async (path) => {
      const name = path.slice(DIR.length + 1)
      if (options.fails?.includes(name) === true) throw new Error(`EACCES ${name}`)
      if (options.missing?.includes(name) === true) return false
      removed.push(name)
      return true
    },
    alive: async () => { if (options.alive instanceof Error) throw options.alive; return options.alive ?? false },
    log: (line) => { lines.push(line) }
  })
  return { done, removed, lines }
}

describe('clearLeftLocks', () => {
  it('removes the lock directory of each database when no node answers, and says which', async () => {
    const { done, removed, lines } = run()
    expect(await done).toEqual([...LOCK_NAMES])
    expect(removed).toEqual(['blocks.db.lock', 'keys.db.lock'])
    expect(lines).toEqual(['removed what a killed node left: blocks.db.lock, keys.db.lock'])
  })

  it('removes nothing while a node answers, since whoever holds a lock is then alive', async () => {
    const { done, removed, lines } = run({ alive: true })
    expect(await done).toEqual([])
    expect(removed).toEqual([])
    expect(lines).toEqual([])
  })

  it('counts a failed check as an answer, and leaves the locks', async () => {
    const { done, removed } = run({ alive: new Error('probe broke') })
    expect(await done).toEqual([])
    expect(removed).toEqual([])
  })

  it('says nothing when there was no lock to remove', async () => {
    const { done, lines } = run({ missing: ['blocks.db.lock', 'keys.db.lock'] })
    expect(await done).toEqual([])
    expect(lines).toEqual([])
  })

  it('goes on with the next directory when one cannot be removed, and logs why', async () => {
    const { done, removed, lines } = run({ fails: ['blocks.db.lock'] })
    expect(await done).toEqual(['keys.db.lock'])
    expect(removed).toEqual(['keys.db.lock'])
    expect(lines[0]).toContain('blocks.db.lock')
    expect(lines[0]).toContain('EACCES')
  })
})
