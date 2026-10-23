// SOURCE.txt is written from the recipe, so it says what the recipe pins.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRecipe } from '../../../src/apps.ts'
import { isSite } from '../../../src/recipe.ts'
import { transformHtml } from '../hooks.mjs'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('hooks', () => {
  it('writes SOURCE.txt with the repository and the pinned commit, and leaves the page alone', async () => {
    const recipe = await loadRecipe('restfox')
    if (isSite(recipe)) throw new Error('restfox is a port')
    dir = await mkdtemp(join(tmpdir(), 'restfox-hooks-'))
    const html = '<html></html>'
    expect(await transformHtml(html, { recipe, dirs: { static: dir } })).toBe(html)
    const text = await readFile(join(dir, 'SOURCE.txt'), 'utf8')
    expect(text).toContain('a community build by Orivon, not the official Restfox')
    expect(text).toContain('Source: https://github.com/flawiddsouza/Restfox\n')
    expect(text).toContain(`Built from commit ${recipe.upstream.ref}`)
    expect(await transformHtml(html, { recipe, dirs: { static: dir } })).toBe(html)
    expect(await readFile(join(dir, 'SOURCE.txt'), 'utf8')).toBe(text)
  })
})
