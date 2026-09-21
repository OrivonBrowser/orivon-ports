import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readState, writeState } from './state.ts'

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
})
