import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readState, recipeDigest, staleBuildNotice, stalePrepareNotice, writeState } from './state.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-state-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('state', () => {
  it('reads back what it wrote', async () => {
    await writeState(dir, { fetchedRef: 'a'.repeat(40) })
    expect((await readState(dir)).fetchedRef).toBe('a'.repeat(40))
  })

  it('merges a patch instead of replacing the file', async () => {
    await writeState(dir, { fetchedRef: 'a'.repeat(40) })
    await writeState(dir, { builtFromRef: 'a'.repeat(40), builtAt: 'now' })
    const state = await readState(dir)
    expect(state.fetchedRef).toBe('a'.repeat(40))
    expect(state.builtAt).toBe('now')
  })

  it('reports an empty state for a directory that has none', async () => {
    expect(await readState(join(dir, 'nothing-here'))).toEqual({})
  })

  // A half-written state file must not be a hard failure: the answer it gives
  // is "redo the work", which is always safe and never wrong.
  it('reports an empty state for a corrupt file rather than throwing', async () => {
    await writeFile(join(dir, '.orivon-state.json'), '{ not json')
    expect(await readState(dir)).toEqual({})
  })

  // `serve` never rebuilds, so a pin moved since the last build is otherwise
  // served silently: the old build keeps answering, and breaks against a site
  // it was never built for.
  describe('staleBuildNotice', () => {
    const pinned = 'b'.repeat(40)

    it('names both commits and the command that fixes it when the build predates the pin', () => {
      const notice = staleBuildNotice('freetube', { builtFromRef: 'a'.repeat(40) }, pinned)
      expect(notice).toContain('aaaaaaaa')
      expect(notice).toContain('bbbbbbbb')
      expect(notice).toContain('orivon-port run freetube')
    })

    it('says nothing when the build is from the pinned commit', () => {
      expect(staleBuildNotice('freetube', { builtFromRef: pinned }, pinned)).toBeUndefined()
    })

    it('says nothing when no build is recorded, which serve reports as nothing built', () => {
      expect(staleBuildNotice('freetube', {}, pinned)).toBeUndefined()
    })
  })

  // A recipe directory edit (a manifest `domain`, a bridge) has to reach the
  // served tree, which an upstream ref alone cannot tell.
  describe('recipeDigest', () => {
    it('changes when any file in the recipe directory changes, nested ones included, and not otherwise', async () => {
      await mkdir(join(dir, 'bridge'))
      await writeFile(join(dir, 'orivon.json'), '{"domain":"a.orivonstack.eth"}')
      await writeFile(join(dir, 'bridge', 'b.js'), 'one')
      const first = await recipeDigest(dir)
      expect(await recipeDigest(dir)).toBe(first)
      await writeFile(join(dir, 'orivon.json'), '{"domain":"b.orivonstack.eth"}')
      const second = await recipeDigest(dir)
      expect(second).not.toBe(first)
      await writeFile(join(dir, 'bridge', 'b.js'), 'two')
      expect(await recipeDigest(dir)).not.toBe(second)
    })

    it('lets serve name a tree prepared from another recipe directory, or from an unknown one', () => {
      expect(stalePrepareNotice('freetube', { preparedFrom: 'a' }, 'a')).toBeUndefined()
      expect(stalePrepareNotice('freetube', { preparedFrom: 'a' }, 'b')).toContain('orivon-port run freetube')
      expect(stalePrepareNotice('freetube', {}, 'b')).toContain('apps/freetube/')
    })

    it('tells a renamed file from an edited one', async () => {
      await writeFile(join(dir, 'a'), 'x')
      const before = await recipeDigest(dir)
      await rm(join(dir, 'a'))
      await writeFile(join(dir, 'b'), 'x')
      expect(await recipeDigest(dir)).not.toBe(before)
    })
  })
})
