// How upstream's file calls are kept inside Orivon's budget: few in flight, and the repeated checks of
// a note's metadata folders asked once. Run on a stand-in for `fs.promises` that counts what reaches it.
import { describe, expect, it } from 'vitest'
import { BURST, createBucket, createQueue, RATE_PER_SECOND, STAT_TTL_MS, pace as paceFs } from './paced-fs.js'

// The bridge is JavaScript: `pace` returns the members of whatever `fs.promises` it was given.
type Call = (...args: any[]) => Promise<any>
type Paced = { lstat: Call, stat: Call, readFile: Call, readdir: Call, mkdir: Call, open: Call, constants: unknown, watch: unknown }
const pace = (...args: Parameters<typeof paceFs>) => paceFs(...args) as unknown as Paced

const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: 'ENOENT' })

function backing (present: Set<string>) {
  const calls: string[] = []
  let running = 0
  let peak = 0
  const hold = async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 1))
    running -= 1
  }
  const promises = {
    constants: { F_OK: 0 },
    async lstat (path: string) { calls.push(`lstat ${path}`); const there = present.has(path); await hold(); if (!there) throw enoent(path); return { path } },
    async stat (path: string) { calls.push(`stat ${path}`); await hold(); if (!present.has(path)) throw enoent(path); return { path, isFile: () => !path.endsWith('/dir'), isDirectory: () => path.endsWith('/dir') } },
    async readFile (path: string) { calls.push(`readFile ${path}`); await hold(); if (!present.has(path)) throw enoent(path); return `body of ${path}` },
    async mkdir (path: string) { calls.push(`mkdir ${path}`); await hold(); present.add(path) },
    async readdir (path: string, options?: { withFileTypes?: boolean }) {
      calls.push(`readdir ${path}${options?.withFileTypes === true ? ' withFileTypes' : ''}`)
      await hold()
      return [...present].filter((entry) => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/')).map((entry) => entry.slice(path.length + 1))
    },
    async open (path: string, flags?: string) { calls.push(`open ${path} ${flags ?? 'r'}`); const there = present.has(path); await hold(); if (!there && !/[wa+]/.test(flags ?? 'r')) throw enoent(path); return { path } },
    watch () { return 'watcher' }
  }
  return { promises, calls, peak: () => peak }
}

describe('createQueue', () => {
  it('runs no more than the limit at once, in the order asked, and lets every call finish', async () => {
    const queued = createQueue(3)
    const order: number[] = []
    let running = 0
    let peak = 0
    await Promise.all(Array.from({ length: 20 }, (_, index) => queued(async () => {
      running += 1
      peak = Math.max(peak, running)
      order.push(index)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running -= 1
      return index
    })))
    expect(peak).toBe(3)
    expect(order).toEqual(Array.from({ length: 20 }, (_, index) => index))
  })

  it('hands the place on when a call throws', async () => {
    const queued = createQueue(1)
    const results = await Promise.allSettled([queued(async () => { throw new Error('first') }), queued(async () => 'second')])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
  })
})

describe('createBucket', () => {
  it('admits the burst at once, then no more than the rate, by a clock that only the waits move', async () => {
    let time = 0
    const take = createBucket({ ratePerSecond: 90, burst: 150, now: () => time, sleep: async (ms) => { time += ms } })
    const admitted: number[] = []
    await Promise.all(Array.from({ length: 1000 }, async () => { await take(); admitted.push(time) }))
    // The clock is read when a caller continues, which can be after a later caller's wait began, so a time is never earlier
    // than the call's own: the k-th call (from 0) cannot have gone before (k + 1 - burst) / rate.
    admitted.forEach((at, index) => { expect(at).toBeGreaterThanOrEqual(Math.floor(((index + 1 - 150) * 1000) / 90) - 1) })
    expect(admitted.filter((at) => at === 0).length).toBeGreaterThan(100)
    expect(time).toBeGreaterThanOrEqual(((1000 - 150) * 1000) / 90 - 20)
  })
})

describe('pace', () => {
  it('keeps the calls that reach the file module under the rate, every underlying call counted, including a folder\'s entries', async () => {
    let time = 0
    const present = new Set(Array.from({ length: 300 }, (_, index) => `/v/n${String(index)}.md`))
    const { promises, calls } = backing(present)
    const stamps: number[] = []
    const stamped = Object.fromEntries(Object.entries(promises).map(([name, fn]) => [name, typeof fn === 'function' ? (...args: unknown[]) => { stamps.push(time); return (fn as (...rest: unknown[]) => unknown)(...args) } : fn]))
    const paced = pace(stamped as typeof promises, { now: () => time, sleep: async (ms: number) => { time += ms } })
    await Promise.all([paced.readdir('/v', { withFileTypes: true }), ...[...present].map((path) => paced.readFile(path))])
    expect(calls.length).toBe(601)
    expect(stamps).toHaveLength(601)
    stamps.forEach((at, index) => { expect(at).toBeGreaterThanOrEqual(Math.floor(((index + 1 - BURST) * 1000) / RATE_PER_SECOND) - 1) })
  })

  it('builds a folder\'s entries from the one stat each, and answers the later stat of the same note from it', async () => {
    const { promises, calls } = backing(new Set(['/v/a.md', '/v/b.md', '/v/dir']))
    const paced = pace(promises)
    const list = await paced.readdir('/v', { withFileTypes: true }) as Array<{ name: string, isFile: () => boolean, isDirectory: () => boolean, isSymbolicLink: () => boolean, parentPath: string }>
    expect(list.map((entry) => [entry.name, entry.isFile(), entry.isDirectory(), entry.isSymbolicLink(), entry.parentPath])).toEqual([
      ['a.md', true, false, false, '/v'], ['b.md', true, false, false, '/v'], ['dir', false, true, false, '/v']
    ])
    await paced.stat('/v/a.md')
    await paced.stat('/v/b.md')
    expect(calls).toEqual(['readdir /v', 'stat /v/a.md', 'stat /v/b.md', 'stat /v/dir'])
  })

  it('answers a plain readdir as the shim does, one call', async () => {
    const { promises, calls } = backing(new Set(['/v/a.md']))
    const paced = pace(promises)
    expect(await paced.readdir('/v')).toEqual(['a.md'])
    expect(calls).toEqual(['readdir /v'])
  })

  it('says an unexpected failure once, and says nothing for the ordinary answers of a probe', async () => {
    const said: string[] = []
    const promises = { async readFile (path: string) { throw Object.assign(new Error('nope'), { code: path.endsWith('missing') ? 'ENOENT' : 'EIO' }) } }
    const paced = pace(promises, { onError: (name: string, path: string) => { said.push(`${name} ${path}`) } })
    await expect(paced.readFile('/v/missing')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(paced.readFile('/v/x')).rejects.toMatchObject({ code: 'EIO' })
    expect(said).toEqual(['readFile /v/x'])
  })

  it('keeps 256 reads asked at once to the limit, and answers every one', async () => {
    const present = new Set(Array.from({ length: 256 }, (_, index) => `/v/n${String(index)}.md`))
    const { promises, peak } = backing(present)
    const paced = pace(promises, { max: 12 })
    const bodies = await Promise.all([...present].map((path) => paced.readFile(path)))
    expect(bodies).toHaveLength(256)
    expect(peak()).toBeLessThanOrEqual(12)
  })

  it('asks once for what 256 notes ask for at the same moment, as the list of a vault does', async () => {
    const { promises, calls } = backing(new Set(['/v/.zennotes']))
    const paced = pace(promises)
    const notes = Array.from({ length: 256 }, (_, index) => index)
    await Promise.all(notes.map(async (index) => {
      await paced.lstat('/v/.zennotes')
      await expect(paced.lstat('/v/.zennotes/note-metadata')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(paced.readFile(`/v/.zennotes/note-metadata/n${String(index)}.json`)).rejects.toMatchObject({ code: 'ENOENT', syscall: 'open' })
    }))
    expect(calls).toEqual(['lstat /v/.zennotes', 'lstat /v/.zennotes/note-metadata'])
  })

  it('asks once for a file that is not there, whoever asks while it is asked and for a while after, and reads one that is there every time', async () => {
    const { promises, calls } = backing(new Set(['/v/here.md']))
    const paced = pace(promises)
    await Promise.all([1, 2, 3, 4].map(async () => { await expect(paced.open('/v/gone.json', 'r')).rejects.toMatchObject({ code: 'ENOENT' }) }))
    await expect(paced.readFile('/v/gone.json')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(calls).toEqual(['open /v/gone.json r'])
    await paced.readFile('/v/here.md')
    await paced.readFile('/v/here.md')
    await Promise.all([paced.open('/v/here.md', 'r'), paced.open('/v/here.md', 'r')])
    expect(calls.filter((call) => call.includes('here.md'))).toEqual(['readFile /v/here.md', 'readFile /v/here.md', 'open /v/here.md r', 'open /v/here.md r'])
  })

  it('asks `lstat` of a folder once for all the notes that check it, found or missing, and says what Node says for a missing one', async () => {
    const { promises, calls } = backing(new Set(['/v/.zennotes', '/v/.zennotes/note-metadata']))
    const paced = pace(promises)
    for (let note = 0; note < 5; note += 1) {
      await paced.lstat('/v/.zennotes')
      await paced.lstat('/v/.zennotes/note-metadata')
      await expect(paced.lstat('/v/.zennotes/note-metadata/inbox')).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(calls).toEqual(['lstat /v/.zennotes', 'lstat /v/.zennotes/note-metadata', 'lstat /v/.zennotes/note-metadata/inbox'])
  })

  it('answers a read under a folder it found missing without asking, and still asks for a path whose folder it has not checked', async () => {
    const { promises, calls } = backing(new Set(['/v/other/x.md']))
    const paced = pace(promises)
    await expect(paced.lstat('/v/.zennotes/note-metadata/inbox')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(paced.readFile('/v/.zennotes/note-metadata/inbox/a.md.metadata.json')).rejects.toMatchObject({ code: 'ENOENT', syscall: 'open' })
    await expect(paced.stat('/v/.zennotes/note-metadata/inbox/a.md.metadata.json')).rejects.toMatchObject({ code: 'ENOENT', syscall: 'stat' })
    expect(calls).toEqual(['lstat /v/.zennotes/note-metadata/inbox'])
    await expect(paced.readFile('/v/other/x.md')).resolves.toBe('body of /v/other/x.md')
  })

  it('forgets what it remembered when something is written, so a folder just made is found', async () => {
    const { promises, calls } = backing(new Set())
    const paced = pace(promises)
    await expect(paced.lstat('/v/.zennotes')).rejects.toMatchObject({ code: 'ENOENT' })
    await paced.mkdir('/v/.zennotes')
    await expect(paced.lstat('/v/.zennotes')).resolves.toEqual({ path: '/v/.zennotes' })
    expect(calls).toEqual(['lstat /v/.zennotes', 'mkdir /v/.zennotes', 'lstat /v/.zennotes'])
  })

  it('forgets on a file opened to write, but not on one opened to read', async () => {
    const { promises, calls } = backing(new Set(['/v/a']))
    const paced = pace(promises)
    await paced.lstat('/v/a')
    await paced.open('/v/a', 'r')
    await paced.lstat('/v/a')
    await paced.open('/v/a', 'w')
    await paced.lstat('/v/a')
    expect(calls.filter((call) => call.startsWith('lstat'))).toHaveLength(2)
  })

  it('does not keep an answer asked for before a write that finished first', async () => {
    const { promises } = backing(new Set())
    const paced = pace(promises)
    const early = paced.lstat('/v/late').then(() => 'found', (error: { code: string }) => error.code)
    await paced.mkdir('/v/late')
    expect(await early).toBe('ENOENT')
    await expect(paced.lstat('/v/late')).resolves.toEqual({ path: '/v/late' })
  })

  it('asks again once the memory is old', async () => {
    let time = 0
    const { promises, calls } = backing(new Set(['/v/a']))
    const paced = pace(promises, { now: () => time })
    await paced.lstat('/v/a')
    time += STAT_TTL_MS + 1
    await paced.lstat('/v/a')
    expect(calls).toEqual(['lstat /v/a', 'lstat /v/a'])
  })

  it('passes data members and the watcher through as they are', () => {
    const { promises } = backing(new Set())
    const paced = pace(promises)
    expect(paced.constants).toBe(promises.constants)
    expect(paced.watch).toBe(promises.watch)
  })
})
