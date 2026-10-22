// Which vault is open, and how the notes are handed out, run without upstream's source.
import { describe, expect, it } from 'vitest'
import { createNoteStream, createSession, UNNAMED } from './session.js'

function fixture () {
  const laidOut: string[] = []
  let clock = 0
  const session = createSession({
    ensureVaultLayout: async (root: string) => { laidOut.push(root) },
    describeVault: async (root: string) => ({ root, name: root.split('/').at(-1) as string }),
    now: () => ++clock
  })
  return { session, laidOut }
}

describe('the open vault', () => {
  it('has none until a folder is opened, and says what upstream says', async () => {
    const { session } = fixture()
    expect(await session.current()).toBeNull()
    expect(() => session.require()).toThrow('No vault is open')
  })

  it('lays out the folder it opens before it describes it', async () => {
    const { session, laidOut } = fixture()
    expect(await session.open('/orivon/picked/a1/Notes')).toEqual({ root: '/orivon/picked/a1/Notes', name: 'Notes' })
    expect(laidOut).toEqual(['/orivon/picked/a1/Notes'])
    expect(session.require().root).toBe('/orivon/picked/a1/Notes')
  })

  it('names a picked folder after nothing but its pick id, so it is called what it is, and keeps a name the vault gave itself', async () => {
    let displayName: string | undefined
    const session = createSession({
      ensureVaultLayout: async () => {},
      describeVault: async (root: string) => ({ root, name: displayName ?? root.split('/').pop() as string })
    })
    expect((await session.open('/orivon/picked/90f1bab1924584c852012395')).name).toBe(UNNAMED)
    displayName = 'Journal'
    expect((await session.open('/orivon/picked/aa11')).name).toBe('Journal')
    displayName = undefined
    expect((await session.open('/not/a/pick/Notes')).name).toBe('Notes')
  })

  it('lists the vaults opened since the page loaded, most recent first', async () => {
    const { session } = fixture()
    await session.open('/orivon/picked/a1')
    await session.open('/orivon/picked/b2')
    expect(session.list().map((entry) => entry.root)).toEqual(['/orivon/picked/b2', '/orivon/picked/a1'])
    expect(session.list()[0]).toMatchObject({ lastOpenedAt: expect.any(Number) })
  })

  it('switches to a vault it opened and answers null for one it did not', async () => {
    const { session } = fixture()
    await session.open('/orivon/picked/a1')
    await session.open('/orivon/picked/b2')
    expect((await session.switchTo('/orivon/picked/a1'))?.root).toBe('/orivon/picked/a1')
    expect(session.require().root).toBe('/orivon/picked/a1')
    expect(await session.switchTo('/orivon/picked/gone')).toBeNull()
    expect(session.require().root).toBe('/orivon/picked/a1')
  })

  it('closes the current vault and moves to the one opened before it, then to none', async () => {
    const { session } = fixture()
    await session.open('/orivon/picked/a1')
    await session.open('/orivon/picked/b2')
    expect((await session.close())?.root).toBe('/orivon/picked/a1')
    expect(await session.close()).toBeNull()
    expect(await session.close()).toBeNull()
    expect(() => session.require()).toThrow('No vault is open')
    expect(session.list()).toEqual([])
  })
})

describe('the list-notes stream', () => {
  const notes = Array.from({ length: 1200 }, (_, index) => ({ path: `inbox/${String(index)}.md` }))

  it('lists once per request and hands the notes out in chunks until done', async () => {
    let listed = 0
    const page = createNoteStream({ listNotes: async () => { listed += 1; return notes } })
    const first = await page('/v', { requestId: 'r', offset: 0, chunkSize: 500 })
    expect(first).toMatchObject({ nextOffset: 500, done: false, total: 1200 })
    expect(first.notes).toHaveLength(500)
    const second = await page('/v', { requestId: 'r', offset: 500, chunkSize: 500 })
    expect(second.notes[0]).toEqual({ path: 'inbox/500.md' })
    const last = await page('/v', { requestId: 'r', offset: 1000, chunkSize: 500 })
    expect(last).toMatchObject({ nextOffset: 1200, done: true })
    expect(last.notes).toHaveLength(200)
    expect(listed).toBe(1)
  })

  it('starts again from the top when a request asks for offset 0, and forgets a stream that went quiet', async () => {
    let listed = 0
    let clock = 0
    const page = createNoteStream({ listNotes: async () => { listed += 1; return notes }, now: () => clock, ttlMs: 10 })
    await page('/v', { requestId: 'r', offset: 0 })
    await page('/v', { requestId: 'r', offset: 0 })
    expect(listed).toBe(2)
    clock = 100
    await page('/v', { requestId: 'r', offset: 500 })
    expect(listed).toBe(3)
  })

  it('uses upstream\'s default and largest chunk, and refuses a request with no id', async () => {
    const page = createNoteStream({ listNotes: async () => notes })
    expect((await page('/v', { requestId: 'a' })).notes).toHaveLength(500)
    expect((await page('/v', { requestId: 'b', chunkSize: 99999 })).notes).toHaveLength(1000)
    await expect(page('/v', { requestId: '' })).rejects.toThrow('Missing list-notes stream request id')
  })
})
