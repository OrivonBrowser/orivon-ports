import { describe, expect, it } from 'vitest'
import { chooseRelease, describeAge, parseRecipe, pinAge, repoOf } from '../site/pins.js'

const SHA = 'a'.repeat(40)
const release = (tag: string, published: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: published, html_url: `https://github.com/o/r/releases/tag/${tag}`, ...extra })

describe('parseRecipe', () => {
  const recipe = (upstream: unknown) => JSON.stringify({ id: 'x', upstream })

  it('reads the repository and the pinned commit, with the release rules', () => {
    expect(parseRecipe(recipe({ repo: 'https://github.com/o/r.git', ref: SHA, licence: 'MIT' }))).toEqual({ repo: 'o/r', ref: SHA, tagPattern: null, prerelease: false })
    expect(parseRecipe(recipe({ repo: 'https://github.com/o/r.git', ref: SHA, tagPattern: '^v', prerelease: true }))).toEqual({ repo: 'o/r', ref: SHA, tagPattern: '^v', prerelease: true })
  })

  it('is null for what is not a port with a pinned commit', () => {
    expect(parseRecipe('not json')).toBeNull()
    expect(parseRecipe(JSON.stringify({ id: 'site', site: 'site' }))).toBeNull()
    expect(parseRecipe(recipe({ repo: 'https://github.com/o/r.git', ref: 'main' }))).toBeNull()
    expect(parseRecipe(recipe({ repo: 'https://gitlab.com/o/r.git', ref: SHA }))).toBeNull()
  })

  it('reads owner/name from a repository URL', () => {
    expect(repoOf('https://github.com/element-hq/element-web.git')).toBe('element-hq/element-web')
    expect(repoOf('https://github.com/asgardex/asgardex-desktop/')).toBe('asgardex/asgardex-desktop')
    expect(repoOf('http://github.com/o/r')).toBeNull()
  })
})

describe('chooseRelease', () => {
  it('takes the newest stable release by date', () => {
    const chosen = chooseRelease([release('v1', '2026-01-01T00:00:00Z'), release('v3', '2026-03-01T00:00:00Z'), release('v2-rc.1', '2026-04-01T00:00:00Z', { prerelease: true }), release('v4', '2026-05-01T00:00:00Z', { draft: true })], { tagPattern: null, prerelease: false })
    expect(chosen?.tag).toBe('v3')
    expect(chosen?.date.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('accepts pre-releases only when the recipe says upstream publishes its releases that way', () => {
    const list = [release('v0.25.3-beta', '2026-08-28T00:00:00Z', { prerelease: true })]
    expect(chooseRelease(list, { tagPattern: null, prerelease: false })).toBeNull()
    expect(chooseRelease(list, { tagPattern: null, prerelease: true })?.tag).toBe('v0.25.3-beta')
  })

  it('keeps only the tags the recipe\'s pattern accepts, and gives up on a pattern that is not one', () => {
    const list = [release('live-mobile@4.24.0', '2026-10-14T00:00:00Z'), release('@ledgerhq/live-desktop@4.23.1', '2026-10-09T00:00:00Z')]
    expect(chooseRelease(list, { tagPattern: '^@ledgerhq/live-desktop@', prerelease: false })?.tag).toBe('@ledgerhq/live-desktop@4.23.1')
    expect(chooseRelease(list, { tagPattern: '([', prerelease: false })).toBeNull()
  })

  it('ignores a release with no usable date', () => {
    expect(chooseRelease([release('v1', 'not a date')], { tagPattern: null, prerelease: false })).toBeNull()
  })
})

describe('pinAge', () => {
  const pinned = new Date('2026-09-01T10:00:00Z')

  it('counts the days the pin is older than the newest release', () => {
    const age = pinAge(pinned, { tag: 'v1.46.1', date: new Date('2026-10-09T10:00:00Z') })
    expect(age).toEqual({ pinned: '2026-09-01', release: 'v1.46.1, 2026-10-09', days: 38, relation: 'behind' })
    expect(describeAge(age)).toBe('the pin is 38 days older than the newest release')
  })

  it('says when the pin is newer than the release, as a pin on a development commit is', () => {
    const age = pinAge(pinned, { tag: 'v0.24.0', date: new Date('2020-08-29T00:00:00Z') })
    expect(age.relation).toBe('ahead')
    expect(describeAge(age)).toMatch(/^the pin is \d+ days newer than the newest release$/)
  })

  it('uses the singular for one day, and says so for the same day', () => {
    expect(describeAge(pinAge(pinned, { tag: 'v1', date: new Date('2026-09-02T10:00:00Z') }))).toBe('the pin is 1 day older than the newest release')
    expect(describeAge(pinAge(pinned, { tag: 'v1', date: new Date('2026-09-01T12:00:00Z') }))).toBe('the pin and the newest release are from the same day')
  })

  it('gives the pin alone when there is no release to compare with', () => {
    const age = pinAge(pinned, null)
    expect(age).toEqual({ pinned: '2026-09-01', release: null, days: null, relation: 'unknown' })
    expect(describeAge(age)).toBe('upstream has no stable release')
  })
})
